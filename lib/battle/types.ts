// Battle domain contract. Pure data + types only: no I/O, no framework imports.
// Node runs these files through native type stripping, so avoid enums/namespaces/parameter properties.
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';

/**
 * Bumped whenever a rule change can alter the outcome of a battle for the same seed + decisions.
 * 2: energy regen 1/turn, round cap 40, wounded-only N self-heal.
 * 3: lower base card stats; player enhance levels are snapshotted into the battle.
 */
export const BATTLE_RULESET_VERSION = 3;

export const ELEMENTS = ['light', 'shadow', 'iron', 'nature', 'spark'] as const;
export type Element = (typeof ELEMENTS)[number];

export const ELEMENT_LABEL: Record<Element, string> = {
  light: '빛',
  shadow: '어둠',
  iron: '강철',
  nature: '자연',
  spark: '전류'
};

/** light → shadow → nature → iron → spark → light. The next element in the ring deals +25%. */
export const ELEMENT_RING: Element[] = ['light', 'shadow', 'nature', 'iron', 'spark'];

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
  /** Player-side duplicate enhance. Omitted or 0 for opponents and old snapshots. */
  enhance?: number;
}

export interface BattleSetup {
  /** Server issued id when the battle is authoritative; omitted in tests. */
  battleId?: string;
  kind: BattleKind;
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
