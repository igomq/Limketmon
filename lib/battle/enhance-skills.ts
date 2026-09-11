// Card-specific additional active skills, unlocked by duplicate enhancement (+5 / +10 / +15).
//
// The *ideas* (name, flavour, archetype) are static data in lib/data/enhance-skills.json. The
// actual ops are derived here from the card's ENHANCED battle stats, so a card and a level always
// produce the same skill, and no numeric table has to be hand-maintained per card.
//
// Balance contract (mirrored by tests/enhance-skills.test.ts):
//   +5   a useful, cheap signature follow-up
//   +10  a team-wide or utility effect
//   +15  a strong capstone
// Every derived ability uses the existing Ability DSL only, so the engine and the validator
// already understand it. All skills of one card spend the SAME energy pool and share the one
// combatant cooldown counter: cooldown is set from whichever skill was chosen last.
import rawIdeas from '../data/enhance-skills.json';
import { clampEnhance, enhancePower } from '../enhance.ts';
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { RARITY_COST, enhanceScale } from './stats.ts';
import type { Ability, AbilityOp, CardBattleStats } from './types.ts';

export const ENHANCE_SKILL_LEVELS = [5, 10, 15] as const;
export type EnhanceSkillLevel = (typeof ENHANCE_SKILL_LEVELS)[number];

export const ENHANCE_ARCHETYPES = [
  'strike',
  'multihit',
  'aoe',
  'poison',
  'stun',
  'atk_up',
  'def_down',
  'shield',
  'regen',
  'heal'
] as const;
export type EnhanceArchetype = (typeof ENHANCE_ARCHETYPES)[number];

export interface EnhanceSkillIdea {
  cardId: string;
  level: EnhanceSkillLevel;
  name: string;
  /** Flavour copy. The mechanics the UI prints are derived from the ops, never from this text. */
  description: string;
  archetype: EnhanceArchetype;
}

export interface EnhanceSkill {
  cardId: string;
  level: EnhanceSkillLevel;
  /** Flavour copy for the sheet; mechanically irrelevant. */
  flavor: string;
  ability: Ability;
}

interface RawEntry {
  cardId: string;
  skills: Array<{ level: number; name: string; description: string; archetype: string }>;
}

const ARCHETYPE_SET: ReadonlySet<string> = new Set(ENHANCE_ARCHETYPES);

const IDEAS: EnhanceSkillIdea[] = (rawIdeas as { cards: RawEntry[] }).cards.flatMap((entry) =>
  (entry.skills ?? [])
    .filter((skill) => ARCHETYPE_SET.has(skill.archetype))
    .map((skill) => ({
      cardId: entry.cardId,
      level: skill.level as EnhanceSkillLevel,
      name: skill.name,
      description: skill.description,
      archetype: skill.archetype as EnhanceArchetype
    }))
    .sort((left, right) => left.level - right.level)
);

const IDEAS_BY_CARD: Map<string, EnhanceSkillIdea[]> = new Map();
for (const idea of IDEAS) {
  const list = IDEAS_BY_CARD.get(idea.cardId);
  if (list) list.push(idea);
  else IDEAS_BY_CARD.set(idea.cardId, [idea]);
}

/** Every stored idea, flattened. Exposed so tooling/tests can audit the data. */
export function allEnhanceSkillIdeas(): EnhanceSkillIdea[] {
  return IDEAS.map((idea) => ({ ...idea }));
}

export function skillIdeasFor(cardId: string): EnhanceSkillIdea[] {
  return IDEAS_BY_CARD.get(cardId) ?? [];
}

/** Static data audit: one idea per (card, level) with a unique name inside its card. */
export function enhanceSkillDataErrors(cardIds: readonly string[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const cardId of cardIds) {
    const ideas = skillIdeasFor(cardId);
    if (ideas.length !== ENHANCE_SKILL_LEVELS.length) errors.push(`${cardId}: expected 3 ideas, found ${ideas.length}`);
    const seenLevels = new Set<number>();
    for (const idea of ideas) {
      if (seenLevels.has(idea.level)) errors.push(`${cardId}: duplicate level ${idea.level}`);
      seenLevels.add(idea.level);
      if (!idea.name || !idea.description) errors.push(`${cardId}: idea at +${idea.level} is missing copy`);
      if (names.has(idea.name)) errors.push(`${cardId}: duplicate skill name ${idea.name}`);
      names.add(idea.name);
    }
  }
  return errors;
}

function tierOf(level: EnhanceSkillLevel): 0 | 1 | 2 {
  return level === 5 ? 0 : level === 10 ? 1 : 2;
}

function round(value: number): number {
  return Math.max(1, Math.round(value));
}

// ---------------------------------------------------------------------------
// Op derivation: archetype x tier, scaled by the card's own enhanced stats.
// ---------------------------------------------------------------------------

function opsFor(archetype: EnhanceArchetype, stats: CardBattleStats, tier: 0 | 1 | 2): AbilityOp[] {
  const atk = stats.atk;
  const hp = stats.maxHp;
  switch (archetype) {
    case 'strike':
      // Several strikes land in one op, so each must clearly beat the free basic attack's 1.0x
      // after the 0.45 DEF factor: a paid skill that only matched it would never be worth the turn.
      if (tier === 0) return [{ op: 'damage', power: round(atk * 1.5), target: 'enemy_active' }];
      if (tier === 1) {
        return [
          { op: 'damage', power: round(atk * 1.2), target: 'enemy_active' },
          { op: 'apply_status', status: 'atk_down', turns: 2, value: 15, target: 'enemy_active' }
        ];
      }
      return [
        { op: 'damage', power: round(atk * 1.5), target: 'enemy_active' },
        { op: 'damage', power: round(atk * 0.8), target: 'enemy_all' }
      ];
    case 'multihit':
      // Per-hit power has to clear DEF on its own, so the multi-hit ratios stay well above 1/2/3.
      if (tier === 0) return [{ op: 'damage', power: round(atk * 0.8), hits: 2, target: 'enemy_active' }];
      if (tier === 1) {
        return [
          { op: 'damage', power: round(atk * 0.7), hits: 3, target: 'enemy_active' },
          { op: 'apply_status', status: 'def_down', turns: 2, value: 15, target: 'enemy_active' }
        ];
      }
      return [
        { op: 'damage', power: round(atk * 0.6), hits: 4, target: 'enemy_active' },
        { op: 'apply_status', status: 'poison', turns: 3, value: round(atk * 0.15), target: 'enemy_active' }
      ];
    case 'aoe':
      // Per-target power still has to clear the 0.45 DEF factor on every enemy; three targets at
      // 0.8x beat one free single target in the average 3v3, and never lose to it outright.
      if (tier === 0) return [{ op: 'damage', power: round(atk * 0.8), target: 'enemy_all' }];
      if (tier === 1) {
        return [
          { op: 'damage', power: round(atk * 0.75), target: 'enemy_all' },
          { op: 'apply_status', status: 'def_down', turns: 2, value: 15, target: 'enemy_all' }
        ];
      }
      return [
        { op: 'damage', power: round(atk * 1), target: 'enemy_all' },
        { op: 'apply_status', status: 'poison', turns: 3, value: round(atk * 0.15), target: 'enemy_all' }
      ];
    case 'poison':
      if (tier === 0) {
        return [
          { op: 'damage', power: round(atk * 0.6), target: 'enemy_active' },
          { op: 'apply_status', status: 'poison', turns: 3, value: round(atk * 0.2), target: 'enemy_active' }
        ];
      }
      if (tier === 1) return [{ op: 'apply_status', status: 'poison', turns: 3, value: round(atk * 0.18), target: 'enemy_all' }];
      return [
        { op: 'damage', power: round(atk * 0.9), target: 'enemy_all' },
        { op: 'apply_status', status: 'poison', turns: 4, value: round(atk * 0.25), target: 'enemy_all' }
      ];
    case 'stun':
      if (tier === 0) return [{ op: 'apply_status', status: 'stun', turns: 1, chance: 35, target: 'enemy_active' }];
      if (tier === 1) return [{ op: 'apply_status', status: 'stun', turns: 1, chance: 30, target: 'enemy_all' }];
      return [
        { op: 'damage', power: round(atk * 1.1), target: 'enemy_active' },
        { op: 'apply_status', status: 'stun', turns: 1, chance: 40, target: 'enemy_active' }
      ];
    case 'atk_up':
      if (tier === 0) return [{ op: 'modify_stat', status: 'atk_up', turns: 3, value: 20, target: 'self' }];
      if (tier === 1) return [{ op: 'apply_status', status: 'atk_up', turns: 3, value: 15, target: 'ally_all' }];
      return [
        { op: 'apply_status', status: 'atk_up', turns: 3, value: 25, target: 'ally_all' },
        { op: 'damage', power: round(atk * 0.7), target: 'enemy_all' }
      ];
    case 'def_down':
      if (tier === 0) return [{ op: 'apply_status', status: 'def_down', turns: 2, value: 20, target: 'enemy_active' }];
      if (tier === 1) return [{ op: 'apply_status', status: 'def_down', turns: 2, value: 15, target: 'enemy_all' }];
      return [
        { op: 'apply_status', status: 'def_down', turns: 2, value: 25, target: 'enemy_all' },
        { op: 'damage', power: round(atk * 0.6), target: 'enemy_all' }
      ];
    case 'shield':
      if (tier === 0) return [{ op: 'shield', amount: round(hp * 0.16), target: 'self' }];
      if (tier === 1) return [{ op: 'shield', amount: round(hp * 0.12), target: 'ally_all' }];
      return [
        { op: 'shield', amount: round(hp * 0.18), target: 'ally_all' },
        { op: 'apply_status', status: 'regen', turns: 3, value: round(hp * 0.05), target: 'ally_all' }
      ];
    case 'regen':
      if (tier === 0) return [{ op: 'apply_status', status: 'regen', turns: 3, value: round(hp * 0.06), target: 'self' }];
      if (tier === 1) return [{ op: 'apply_status', status: 'regen', turns: 3, value: round(hp * 0.05), target: 'ally_all' }];
      return [
        { op: 'apply_status', status: 'regen', turns: 3, value: round(hp * 0.07), target: 'ally_all' },
        { op: 'shield', amount: round(hp * 0.12), target: 'ally_all' }
      ];
    case 'heal':
      if (tier === 0) return [{ op: 'heal', amount: round(hp * 0.2), target: 'self' }];
      if (tier === 1) return [{ op: 'heal', amount: round(hp * 0.14), target: 'ally_all' }];
      return [
        { op: 'heal', amount: round(hp * 0.2), target: 'ally_all' },
        { op: 'apply_status', status: 'atk_up', turns: 3, value: 15, target: 'ally_all' }
      ];
  }
}

/** Cost climbs one step per tier off the rarity's signature cost; a capstone is a real investment. */
export function enhanceSkillCost(rarity: Rarity, level: EnhanceSkillLevel): number {
  return Math.min(10, RARITY_COST[rarity] + tierOf(level));
}

export function enhanceSkillCooldown(level: EnhanceSkillLevel): number {
  return tierOf(level);
}

export function enhanceSkillId(cardId: string, level: EnhanceSkillLevel): string {
  return `skill:${cardId}:${level}`;
}

function catalogId(card: Card): string {
  return card.baseCardId ?? card.id;
}

/** Every unlockable skill of a card, in level order, derived from its enhanced stats. */
export function enhanceSkillsForCard(card: Card, stats: CardBattleStats): EnhanceSkill[] {
  const id = catalogId(card);
  return skillIdeasFor(id).map((idea) => ({
    cardId: id,
    level: idea.level,
    flavor: idea.description,
    ability: {
      id: enhanceSkillId(id, idea.level),
      name: idea.name,
      description: idea.description,
      cost: enhanceSkillCost(card.rarity, idea.level),
      cooldown: enhanceSkillCooldown(idea.level),
      ops: opsFor(idea.archetype, stats, tierOf(idea.level))
    }
  }));
}

/** The subset a combatant actually owns at this enhance level; 0..4 unlock nothing. */
export function unlockedEnhanceSkills(card: Card, stats: CardBattleStats, enhanceLevel: number): EnhanceSkill[] {
  const level = clampEnhance(enhanceLevel);
  return enhanceSkillsForCard(card, stats).filter((skill) => skill.level <= level);
}

// ---------------------------------------------------------------------------
// Base-ability potency: the raw signature was written against un-normalized stats, so at a high
// rarity / enhance level its fixed numbers (damage, heal, shield, poison/regen ticks) fall behind
// the combatant's own stats. Percentages, chances, turn counts and energy stay untouched.
// ---------------------------------------------------------------------------

export function scaleAbility(ability: Ability, rarity: Rarity, enhanceLevel: number, baseRarity: Rarity = rarity): Ability {
  const scale = enhanceScale(baseRarity, 0) * enhancePower(rarity, enhanceLevel) / enhancePower(baseRarity, 0);
  if (scale === 1) return ability;
  return { ...ability, ops: scaleOps(ability.ops, scale) };
}

function scaleOps(ops: readonly AbilityOp[], scale: number): AbilityOp[] {
  return ops.map((op) => {
    switch (op.op) {
      case 'damage':
        return { ...op, power: Math.max(1, Math.round(op.power * scale)) };
      case 'heal':
      case 'shield':
        return { ...op, amount: Math.max(1, Math.round(op.amount * scale)) };
      case 'apply_status':
        // Only the flat per-turn ticks scale; atk/def percentages and stun are left alone.
        return op.status === 'poison' || op.status === 'regen'
          ? { ...op, value: Math.max(1, Math.round((op.value ?? 0) * scale)) }
          : op;
      case 'conditional':
        return { ...op, then: scaleOps(op.then, scale) };
      default:
        return op;
    }
  });
}
