// Battle domain contract. Pure data + types only: no I/O, no framework imports.
// Node runs these files through native type stripping, so avoid enums/namespaces/parameter properties.
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { traitValue, type Trait, type TraitId } from '../progression.ts';

/**
 * Bumped whenever a rule change can alter the outcome of a battle for the same seed + decisions.
 * 2: energy regen 1/turn, round cap 40, wounded-only N self-heal.
 * 3: lower base card stats; player enhance levels are snapshotted into the battle.
 * 4: rarity-normalized card stats and per-mode opponents; old pending rows are refused.
 * 5: earth/water/fire/grass/dark elements, member positions, owned-card traits and the
 *    2-round element link. A row stored under 4 or earlier is refused (see lib/game.ts)
 *    instead of re-simulated with rules it was never played under.
 * 6: extreme mode, grown opponent loadouts, retuned hard/chaos scale.
 * 7: hard/chaos difficulty pulled back; chaos ace+ loadouts no longer jump rarity.
 * 8: durability retune (more HP/DEF, less ATK) and hard-boss below chaos-regular.
 */
export const BATTLE_RULESET_VERSION = 9;

export const BATTLE_MODES = ['normal', 'hard', 'chaos', 'extreme'] as const;
export type BattleMode = (typeof BATTLE_MODES)[number];

export const ELEMENTS = ['earth', 'water', 'fire', 'grass', 'dark'] as const;
export type Element = (typeof ELEMENTS)[number];

export const ELEMENT_LABEL: Record<Element, string> = {
  earth: '대지',
  water: '물',
  fire: '불',
  grass: '풀',
  dark: '암흑'
};

/** water → fire → grass → earth → dark → water. The next element in the ring deals +25%. */
export const ELEMENT_RING: Element[] = ['water', 'fire', 'grass', 'earth', 'dark'];

// ---------------------------------------------------------------------------
// Member position (role) — derived from the ability ops, shown in Korean.
// ---------------------------------------------------------------------------

export const POSITIONS = ['healer', 'tank', 'dealer', 'support'] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_LABEL: Record<Position, string> = {
  healer: '힐러',
  tank: '탱커',
  dealer: '딜러',
  support: '지원'
};

/** Priority 회복 → 보호 → 상태이상 → 공격, exactly the order the design spec lists them in. */
export function positionOf(ability: Ability): Position {
  const kinds = opKinds(ability.ops);
  if (kinds.heal) return 'healer';
  if (kinds.shield) return 'tank';
  if (kinds.status) return 'support';
  return 'dealer';
}

/** Which op families an ability (conditionals included) uses at least once. */
function opKinds(ops: readonly AbilityOp[]): { heal: boolean; shield: boolean; status: boolean } {
  const kinds = { heal: false, shield: false, status: false };
  for (const op of ops) {
    if (op.op === 'heal') kinds.heal = true;
    else if (op.op === 'shield') kinds.shield = true;
    else if (op.op === 'apply_status' || op.op === 'modify_stat') kinds.status = true;
    else if (op.op === 'conditional') {
      const nested = opKinds(op.then);
      kinds.heal = kinds.heal || nested.heal;
      kinds.shield = kinds.shield || nested.shield;
      kinds.status = kinds.status || nested.status;
    }
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Element link (연계): the last element that hit a target, and the pairs that pay off.
// ---------------------------------------------------------------------------

export interface ElementMark {
  element: Element;
  round: number;
}

export interface ElementLink {
  /** Element of the earlier hit, still recorded on the target. */
  from: Element;
  /** Element of the follow-up hit that cashes the mark in. */
  to: Element;
  name: string;
}

export const ELEMENT_LINKS: ElementLink[] = [
  { from: 'fire', to: 'water', name: '증발' },
  { from: 'water', to: 'grass', name: '개화' },
  { from: 'grass', to: 'fire', name: '연소' },
  { from: 'earth', to: 'dark', name: '침식' },
  { from: 'dark', to: 'earth', name: '붕괴' }
];

/** Follow-up damage multiplier of a link; a synergy trait grows it further. */
export const SYNERGY_BASE = 1.3;
/** The marked element must be at most this many rounds old when the follow-up lands. */
export const SYNERGY_WINDOW_ROUNDS = 2;
/** No single resistance trait may cut more than this share of the incoming damage. */
export const RESIST_MAX = 0.7;

const LINK_BY_PAIR = new Map(ELEMENT_LINKS.map((link) => [`${link.from}>${link.to}`, link]));

export function elementLinkOf(from: Element, to: Element): ElementLink | undefined {
  return LINK_BY_PAIR.get(`${from}>${to}`);
}

/** Trait that reduces incoming damage of one element. */
export function resistTraitId(element: Element): TraitId {
  return `resist_${element}` as TraitId;
}

/** Highest effective value of one trait id on a card. Missing trait = 0. */
export function traitEffect(traits: readonly Trait[] | undefined, id: TraitId): number {
  let best = 0;
  for (const trait of traits ?? []) {
    if (trait.id !== id) continue;
    const value = traitValue(trait);
    if (value > best) best = value;
  }
  return best;
}

export const STATUS_IDS = [
  'poison',
  'regen',
  'shield',
  'stun',
  'atk_up',
  'atk_down',
  'def_up',
  'def_down'
] as const;
export type StatusId = (typeof STATUS_IDS)[number];

export const STATUS_LABEL: Record<StatusId, string> = {
  poison: '중독',
  regen: '회복',
  shield: '보호막',
  stun: '기절',
  atk_up: '공격 강화',
  atk_down: '공격 약화',
  def_up: '방어 강화',
  def_down: '방어 약화'
};

/** value semantics per status: shield = remaining pool, poison/regen = per-turn amount, *_up/_down = percent delta. */
export interface StatusInstance {
  id: StatusId;
  turns: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Ability DSL (data driven, validated, never a JavaScript callback)
// ---------------------------------------------------------------------------

export type AbilityTarget =
  | 'enemy_active'
  | 'enemy_lowest_hp'
  | 'enemy_all'
  | 'self'
  | 'ally_lowest_hp'
  | 'ally_all';

export interface AbilityCondition {
  selfHpBelow?: number;
  targetHpBelow?: number;
  turnAtLeast?: number;
  targetHasStatus?: StatusId;
}

export type AbilityOp =
  | { op: 'damage'; power: number; hits?: number; target?: AbilityTarget }
  | { op: 'heal'; amount: number; target?: AbilityTarget }
  | { op: 'shield'; amount: number; target?: AbilityTarget }
  | { op: 'apply_status'; status: StatusId; turns: number; value?: number; chance?: number; target?: AbilityTarget }
  | { op: 'modify_stat'; status: StatusId; turns: number; value: number; target?: AbilityTarget }
  | { op: 'conditional'; when: AbilityCondition; then: AbilityOp[] };

export interface Ability {
  id: string;
  name: string;
  description: string;
  /** Energy spent when the skill fires. Basic attacks are free. */
  cost: number;
  /** Rounds the skill is unavailable after use. 0 = every time energy allows. */
  cooldown: number;
  ops: AbilityOp[];
}

// ---------------------------------------------------------------------------
// Battle state
// ---------------------------------------------------------------------------

export type Side = 'a' | 'b';
export type BattleStatus = 'active' | 'won' | 'lost' | 'draw';
export type BattleKind = 'pve' | 'daily';

export type BattleModifier =
  | { kind: 'none' }
  /** Deck building rule, enforced before the battle starts; the engine only carries it for the log. */
  | { kind: 'rarity_cap'; max: Rarity }
  | { kind: 'element_boost'; element: Element; bonus: number }
  /** Player must win before this round ends. */
  | { kind: 'turn_limit'; turns: number };

export interface Combatant {
  /** Stable id inside one battle: 'a0' | 'a1' | 'a2' | 'b0' | 'b1' | 'b2'. */
  uid: string;
  side: Side;
  slot: number;
  cardId: string;
  name: string;
  rarity: Rarity;
  element: Element;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  /** Critical hit chance in percent: 5 + luck/10, so 5..15 across the catalog. */
  crit: number;
  energy: number;
  cooldown: number;
  ability: Ability;
  /** Additional active skills unlocked by duplicate enhancement. Empty for opponents and old snapshots. */
  skills: Ability[];
  /** Role derived from the signature ability ops (healer/tank/dealer/support). */
  position: Position;
  /** Characteristic traits carried by the owned card row; empty for opponents and old snapshots. */
  traits: Trait[];
  /** Last element that damaged this combatant, with the round it landed, for the element link. */
  mark: ElementMark | null;
  statuses: StatusInstance[];
}

export interface CombatantSeed {
  cardId: string;
  name: string;
  rarity: Rarity;
  element: Element;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  crit: number;
  ability: Ability;
  /** Unlocked enhancement skills (never the base ability). Omitted for opponents and old snapshots. */
  skills?: Ability[];
  /** Player-side duplicate enhance. Omitted or 0 for opponents and old snapshots. */
  enhance?: number;
  /** Role; omitted (old snapshots, hand-written fixtures) derives it from the ability. */
  position?: Position;
  /** Characteristic traits of the owned row. Omitted means none. */
  traits?: Trait[];
}

export interface BattleSetup {
  /** Server issued id when the battle is authoritative; omitted in tests. */
  battleId?: string;
  kind: BattleKind;
  /** Difficulty mode the setup was built under. Omitted means 'normal'. */
  mode?: BattleMode;
  opponentId: string;
  modifier: BattleModifier;
  /** 32-bit unsigned seed. */
  seed: number;
  player: CombatantSeed[];
  opponent: CombatantSeed[];
}

export interface BattleState {
  ruleset: number;
  battleId?: string;
  kind: BattleKind;
  opponentId: string;
  modifier: BattleModifier;
  seed: number;
  /** Mutable PRNG word. Every engine step derives randomness only from this value. */
  rng: number;
  /** Number of PRNG draws consumed so far. Fixed budget per action keeps replays aligned. */
  rngDraws: number;
  /** 1-based round number. */
  round: number;
  /** Acting order for the current round; the first entry is the active combatant. */
  queue: string[];
  activeUid: string | null;
  sides: { a: Combatant[]; b: Combatant[] };
  status: BattleStatus;
  /** Why the battle ended: 'hp' | 'turn_limit' | 'timeout'. */
  endReason?: 'hp' | 'turn_limit' | 'timeout';
  damageBy: Record<string, number>;
  log: BattleEvent[];
}

// ---------------------------------------------------------------------------
// Events (the animation + log layer; the UI must never re-derive rules)
// ---------------------------------------------------------------------------

export type BattleEvent =
  | { t: 'start'; round: number }
  | { t: 'turn'; uid: string; round: number }
  | { t: 'action'; uid: string; action: 'attack' | 'skill'; abilityName?: string }
  | {
      t: 'damage';
      uid: string;
      target: string;
      amount: number;
      source: 'attack' | 'skill' | 'poison';
      crit: boolean;
      element: 'strong' | 'weak' | 'neutral';
      absorbed: number;
      /** Set when this hit cashed in a 2-round element link (연계). */
      synergy?: { name: string; multiplier: number };
    }
  | { t: 'heal'; uid: string; target: string; amount: number; source: 'skill' | 'regen' }
  | { t: 'shield'; uid: string; target: string; amount: number }
  | { t: 'status'; uid: string; target: string; status: StatusId; turns: number; applied: boolean }
  | { t: 'skip'; uid: string; reason: 'stun' | 'down' }
  | { t: 'down'; uid: string }
  | { t: 'warn'; message: string }
  | { t: 'end'; status: BattleStatus; round: number; reason: 'hp' | 'turn_limit' | 'timeout' };

export interface Decision {
  /** Must equal state.activeUid; a mismatch is an illegal decision. */
  uid: string;
  action: 'attack' | 'skill';
  /**
   * Which skill to fire. Omitted means the combatant's base signature ability, which is also what
   * every pre-skill log stored. When present it must match one of the actor's unlocked
   * `skills`; anything else (including an id on an `attack`) is rejected before any mutation.
   */
  skillId?: string;
}

export interface AdvanceResult {
  state: BattleState;
  /** Events produced by this step only; state.log holds the full history. */
  events: BattleEvent[];
  /** Present when the decision was rejected; the state is returned unchanged. */
  error?: string;
}

/** Deterministic opponent policy. Must be pure: same state in, same decision out, no RNG. */
export interface AiProfile {
  /** Below this HP ratio the AI prefers healing over damage. */
  healBelow: number;
  /** Below this HP ratio the AI prioritises lethal damage above everything else. */
  lethalFirst: boolean;
  /** Skip the skill unless at least this share of the enemy team is still alive. */
  skillMinTargets: number;
  /** 0 = never skills, 1 = skills whenever energy allows. Deterministic threshold. */
  skillAppetite: number;
}

/** Optional grown copy of a catalog card used by higher-difficulty modes. */
export interface OpponentLoadout {
  cardId: string;
  enhance: number;
  rarity?: Rarity;
  traits?: Trait[];
}

export interface Opponent {
  id: string;
  name: string;
  title: string;
  difficulty: 'beginner' | 'normal' | 'hard' | 'boss';
  blurb: string;
  /** Card ids from the curated manifest, in slot order. */
  cards: string[];
  /** Applied to every derived combat stat; keeps difficulty honest without hand-tuning decks. */
  hpScale: number;
  /** Multiplier for ATK and DEF. Scales with difficulty mode to keep fights threatening. */
  statScale?: number;
  /** DEF-only multiplier when durability is split from ATK. Missing means use statScale. */
  defScale?: number;
  /** When set, opponentTeam builds these grown rows instead of bare catalog cards. */
  loadout?: OpponentLoadout[];
  profile: AiProfile;
  reward: { credits: number; label: string };
}

export interface CardBattleStats {
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  crit: number;
  element: Element;
  cost: number;
  ability: Ability;
}

export type BattleCard = Card;
