// Deterministic ability derivation: a rarity template flavoured by element.
// No hand-authored per-card table; CURATED_ABILITIES only retunes a handful of signatures.
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { RARITY_COST, elementOf } from './stats.ts';
import { STATUS_IDS, type Ability, type AbilityOp, type AbilityTarget, type Element } from './types.ts';

/** 2: the N template heals only when wounded and for less than its hit. */
export const ABILITY_RULESET = 2;

const RARITY_COOLDOWN: Record<Rarity, number> = { N: 0, R: 1, SR: 2, SSR: 2, UR: 3 };

const MAX_OPS = 8;
const MAX_CONDITIONAL_DEPTH = 1;
const TARGETS: readonly string[] = ['enemy_active', 'enemy_lowest_hp', 'enemy_all', 'self', 'ally_lowest_hp', 'ally_all'];
const STATUS_SET: ReadonlySet<string> = new Set(STATUS_IDS);
const STAT_STATUS_SET: ReadonlySet<string> = new Set(['atk_up', 'atk_down', 'def_up', 'def_down']);
const CONDITION_KEYS: readonly string[] = ['selfHpBelow', 'targetHpBelow', 'turnAtLeast', 'targetHasStatus'];

/** damage op helper so every template keeps integer power. */
function hit(card: Card, ratio: number, hits = 1): AbilityOp {
  const power = Math.max(1, Math.round(card.attack * ratio));
  return hits > 1
    ? { op: 'damage', power, hits, target: 'enemy_active' }
    : { op: 'damage', power, target: 'enemy_active' };
}

/** Element-flavoured status rider: light buffs the team, everything else debuffs. */
function rider(element: Element, card: Card, target: AbilityTarget): AbilityOp {
  switch (element) {
    case 'light':
      return { op: 'apply_status', status: 'atk_up', turns: 2, value: 12, target: 'ally_all' };
    case 'shadow':
      return { op: 'apply_status', status: 'atk_down', turns: 2, value: 15, target };
    case 'iron':
      return { op: 'apply_status', status: 'def_down', turns: 2, value: 20, target };
    case 'nature':
      return { op: 'apply_status', status: 'poison', turns: 3, value: 3 + Math.round(card.attack / 25), target };
    case 'spark':
      return { op: 'apply_status', status: 'stun', turns: 1, chance: 35, target };
  }
}

/**
 * Rarity templates:
 *   N   cheap single hit, plus a small self-heal when the card is tankier than it hits
 *   R   single hit + element status rider
 *   SR  three-hit multi when it hits harder than it crits, otherwise a self atk buff + hit
 *   SSR team-wide damage (or an ally-wide shield when the card is a wall), plus rider
 *   UR  conditional finisher (bonus damage + self heal below 60% HP), then team-wide hit
 */
function templateOps(card: Card, element: Element): AbilityOp[] {
  switch (card.rarity) {
    case 'N': {
      const ops: AbilityOp[] = [hit(card, 1)];
      // Wounded-only recovery, deliberately smaller than the hit above it: an unconditional
      // self-heal on every N tank made the beginner bracket a 30-round stalemate, because both
      // sides healed as fast as they hit.
      if (card.defense > card.attack) {
        ops.push({
          op: 'conditional',
          when: { selfHpBelow: 40 },
          then: [{ op: 'heal', amount: 4 + Math.round(card.defense / 20), target: 'self' }]
        });
      }
      return ops;
    }
    case 'R':
      return [hit(card, 0.8), rider(element, card, 'enemy_active')];
    case 'SR':
      return card.luck >= 85
        ? [
            { op: 'modify_stat', status: 'atk_up', turns: 3, value: 20, target: 'self' },
            { op: 'damage', power: Math.max(1, Math.round(card.attack * 0.6)), target: 'enemy_active' }
          ]
        : [hit(card, 0.5, 3)];
    case 'SSR':
      return card.defense >= 80
        ? [
            { op: 'shield', amount: 18 + Math.round(card.defense / 3), target: 'ally_all' },
            { op: 'damage', power: Math.max(1, Math.round(card.attack * 0.5)), target: 'enemy_active' }
          ]
        : [
            { op: 'damage', power: Math.max(1, Math.round(card.attack * 0.7)), target: 'enemy_all' },
            rider(element, card, 'enemy_all')
          ];
    case 'UR':
      return [
        {
          op: 'conditional',
          when: { selfHpBelow: 60 },
          then: [
            { op: 'damage', power: Math.max(1, Math.round(card.attack * 1.2)), target: 'enemy_active' },
            { op: 'heal', amount: 20, target: 'self' }
          ]
        },
        { op: 'damage', power: Math.max(1, Math.round(card.attack * 0.6)), target: 'enemy_all' },
        rider(element, card, 'enemy_all')
      ];
  }
}

/**
 * Optional hand tuning for a few signature cards. Only ops/cooldown are honoured: names,
 * descriptions and the rarity cost table stay authoritative so Korean UI copy never drifts.
 */
export const CURATED_ABILITIES: Record<string, Partial<Ability>> = {
  'imsingyu-v033': {
    cooldown: 3,
    ops: [
      {
        op: 'conditional',
        when: { selfHpBelow: 70 },
        then: [
          { op: 'damage', power: 120, target: 'enemy_all' },
          { op: 'heal', amount: 30, target: 'self' }
        ]
      },
      { op: 'damage', power: 70, target: 'enemy_active' }
    ]
  },
  'imsingyu-v028': {
    ops: [
      { op: 'damage', power: 26, hits: 4, target: 'enemy_active' },
      { op: 'apply_status', status: 'def_down', turns: 2, value: 25, target: 'enemy_active' }
    ]
  },
  'imsingyu-v046': {
    ops: [
      { op: 'shield', amount: 60, target: 'ally_all' },
      { op: 'apply_status', status: 'regen', turns: 3, value: 8, target: 'ally_all' }
    ]
  }
};

export function abilityFor(card: Card): Ability {
  const override = CURATED_ABILITIES[card.id];
  return {
    id: `ability:${card.id}@${ABILITY_RULESET}`,
    name: card.skillName,
    description: card.skillDescription,
    // Rarity cost table stays authoritative so "cheap low-rarity skill" holds for every card.
    cost: RARITY_COST[card.rarity],
    cooldown: override?.cooldown ?? RARITY_COOLDOWN[card.rarity],
    ops: override?.ops ?? templateOps(card, elementOf(card))
  };
}

// ---------------------------------------------------------------------------
// Validation: the DSL is data, so it must survive arbitrary JSON without throwing.
// ---------------------------------------------------------------------------

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkTarget(op: Record<string, unknown>, path: string, errors: string[]): void {
  if (op.target === undefined) return;
  if (typeof op.target !== 'string' || !TARGETS.includes(op.target)) errors.push(`${path}.target is not a known target`);
}

function checkAmount(op: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  const value = op[key];
  if (!isNumber(value) || value < 0) errors.push(`${path}.${key} must be a number >= 0`);
}

function checkCondition(when: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(when)) {
    errors.push(`${path}.when must be an object`);
    return;
  }
  for (const key of Object.keys(when)) {
    if (!CONDITION_KEYS.includes(key)) errors.push(`${path}.when.${key} is not a known condition`);
  }
  for (const key of CONDITION_KEYS) {
    const value = when[key];
    if (value === undefined) continue;
    if (key === 'targetHasStatus') {
      if (typeof value !== 'string' || !STATUS_SET.has(value)) errors.push(`${path}.when.targetHasStatus is not a known status`);
    } else if (!isNumber(value) || value < 0) {
      errors.push(`${path}.when.${key} must be a number >= 0`);
    }
  }
}

function checkOp(raw: unknown, path: string, depth: number, errors: string[]): void {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const kind = raw.op;
  switch (kind) {
    case 'damage':
      checkAmount(raw, 'power', path, errors);
      if (raw.hits !== undefined && (!isInt(raw.hits) || raw.hits < 1 || raw.hits > MAX_OPS)) {
        errors.push(`${path}.hits must be an integer in 1..${MAX_OPS}`);
      }
      checkTarget(raw, path, errors);
      return;
    case 'heal':
    case 'shield':
      checkAmount(raw, 'amount', path, errors);
      checkTarget(raw, path, errors);
      return;
    case 'apply_status': {
      if (typeof raw.status !== 'string' || !STATUS_SET.has(raw.status)) errors.push(`${path}.status is not a known status`);
      if (!isInt(raw.turns) || raw.turns < 0 || raw.turns > 10) errors.push(`${path}.turns must be an integer in 0..10`);
      if (raw.value !== undefined) checkAmount(raw, 'value', path, errors);
      if (raw.chance !== undefined && (!isNumber(raw.chance) || raw.chance < 0 || raw.chance > 100)) {
        errors.push(`${path}.chance must be a number in 0..100`);
      }
      checkTarget(raw, path, errors);
      return;
    }
    case 'modify_stat':
      if (typeof raw.status !== 'string' || !STAT_STATUS_SET.has(raw.status)) errors.push(`${path}.status must be a stat status`);
      if (!isInt(raw.turns) || raw.turns < 0 || raw.turns > 10) errors.push(`${path}.turns must be an integer in 0..10`);
      if (!isNumber(raw.value)) errors.push(`${path}.value must be a number`);
      checkTarget(raw, path, errors);
      return;
    case 'conditional':
      if (depth >= MAX_CONDITIONAL_DEPTH) {
        errors.push(`${path} nests a conditional deeper than ${MAX_CONDITIONAL_DEPTH}`);
        return;
      }
      checkCondition(raw.when, path, errors);
      if (!Array.isArray(raw.then) || raw.then.length === 0 || raw.then.length > MAX_OPS) {
        errors.push(`${path}.then must be an array of 1..${MAX_OPS} ops`);
        return;
      }
      checkOps(raw.then, `${path}.then`, depth + 1, errors);
      return;
    default:
      errors.push(`${path}.op is not a known op`);
  }
}

function checkOps(ops: unknown[], path: string, depth: number, errors: string[]): void {
  ops.forEach((op, index) => checkOp(op, `${path}[${index}]`, depth, errors));
}

export function validateAbility(input: unknown): { ok: boolean; ability?: Ability; errors: string[] } {
  if (!isPlainObject(input)) return { ok: false, errors: ['ability must be an object'] };

  const errors: string[] = [];
  for (const key of ['id', 'name', 'description'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) errors.push(`${key} must be a non-empty string`);
  }
  const cost = input.cost;
  if (!isInt(cost) || cost < 0 || cost > 10) errors.push('cost must be an integer in 0..10');
  const cooldown = input.cooldown;
  if (!isInt(cooldown) || cooldown < 0 || cooldown > 5) errors.push('cooldown must be an integer in 0..5');
  if (!Array.isArray(input.ops) || input.ops.length === 0) errors.push('ops must be a non-empty array');
  else if (input.ops.length > MAX_OPS) errors.push(`ops must hold at most ${MAX_OPS} entries`);
  else checkOps(input.ops, 'ops', 0, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    ability: {
      id: input.id as string,
      name: input.name as string,
      description: input.description as string,
      cost: cost as number,
      cooldown: cooldown as number,
      ops: input.ops as AbilityOp[]
    }
  };
}

export function validateAllAbilities(cards: Card[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const ability = abilityFor(card);
    const result = validateAbility(ability);
    for (const message of result.errors) errors.push(`${card.id}: ${message}`);
    if (seen.has(ability.id)) errors.push(`${card.id}: duplicate ability id ${ability.id}`);
    seen.add(ability.id);
  }
  return errors;
}
