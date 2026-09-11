// Enhancement skills: the +5 / +10 / +15 unlocks, their DSL, and the engine/decision rules that
// make a chosen skill replayable. Pure modules only, no database.
import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';
import type { Ability, BattleSetup, CombatantSeed, Decision } from '../lib/battle/types.ts';
import { advance, createBattle } from '../lib/battle/engine.ts';
import { runBattle, stepBattle } from '../lib/battle/simulate.ts';
import { validateAbility } from '../lib/battle/abilities.ts';
import { buildSetup, combatantSeed } from '../lib/battle/setup.ts';
import { opponentById } from '../lib/battle/opponents.ts';
import { deciderFor } from '../lib/battle/ai.ts';
import { applyEnhance, MAX_ENHANCE } from '../lib/enhance.ts';
import { battleStats, enhanceScale } from '../lib/battle/stats.ts';
import {
  ENHANCE_SKILL_LEVELS,
  allEnhanceSkillIdeas,
  enhanceSkillDataErrors,
  enhanceSkillsForCard,
  scaleAbility,
  unlockedEnhanceSkills
} from '../lib/battle/enhance-skills.ts';

const CARDS = manifest.cards as Card[];
const CARD_IDS = CARDS.map((card) => card.id);

/** A generic combatant that never dies of its own volition, so a single turn is easy to assert on. */
function unit(uid: string, side: 'a' | 'b', slot: number, extra: Partial<CombatantSeed> = {}): CombatantSeed {
  return {
    cardId: `test-${uid}`,
    name: uid,
    rarity: 'SSR',
    element: 'nature',
    maxHp: 50000,
    atk: 10,
    def: 200,
    spd: 10 + slot,
    crit: 0,
    ability: { id: `base:${uid}`, name: '기본 기술', description: '', cost: 1, cooldown: 0, ops: [{ op: 'damage', power: 1, target: 'enemy_active' }] },
    ...extra
  };
}

function setup(player: CombatantSeed[], opponent: CombatantSeed[] = [unit('b0', 'b', 0)]): BattleSetup {
  return { kind: 'pve', opponentId: 'sponge', modifier: { kind: 'none' }, seed: 1234, player, opponent };
}

const unlockedSkills = (card: Card, level: number) => unlockedEnhanceSkills(card, applyEnhance(battleStats(card), level, card.rarity), level);

// ---------------------------------------------------------------------------

test('enhance skills: all 46 cards unlock one new skill per boundary, with valid unique DSL', () => {
  assert.equal(CARDS.length, 46);
  assert.deepEqual(enhanceSkillDataErrors(CARD_IDS), []);
  const boundaries: Array<[number, number]> = [[4, 0], [5, 1], [9, 1], [10, 2], [14, 2], [15, 3]];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const card of CARDS) {
    for (const [level, expected] of boundaries) {
      assert.equal(unlockedSkills(card, level).length, expected, `${card.id} at +${level}`);
    }
    const skills = enhanceSkillsForCard(card, applyEnhance(battleStats(card), MAX_ENHANCE, card.rarity));
    assert.deepEqual(skills.map((skill) => skill.level), [...ENHANCE_SKILL_LEVELS], card.id);
    assert.equal(new Set(skills.map((skill) => skill.ability.id)).size, 3, card.id);
    for (const skill of skills) {
      // Each skill uses the existing DSL only, so the shared validator and engine accept it.
      assert.deepEqual(validateAbility(skill.ability).errors, [], `${card.id} +${skill.level}`);
      assert.ok(!ids.has(skill.ability.id), `duplicate skill id ${skill.ability.id}`);
      assert.ok(!names.has(skill.ability.name), `duplicate skill name ${skill.ability.name}`);
      assert.ok(skill.flavor.length > 0, `${card.id} +${skill.level} flavor`);
      ids.add(skill.ability.id);
      names.add(skill.ability.name);
    }
    // Tiering: a +10 is not a renamed +5, a +15 is not a renamed +10.
    const [tier5, tier10, tier15] = skills.map((skill) => skill.ability);
    assert.notDeepEqual(tier5!.ops, tier10!.ops, card.id);
    assert.notDeepEqual(tier10!.ops, tier15!.ops, card.id);
    assert.ok(tier5!.cost <= tier10!.cost && tier10!.cost <= tier15!.cost, `${card.id} costs climb`);
    assert.ok(tier15!.cooldown >= tier5!.cooldown, `${card.id} capstone cooldown`);

    // A paid burst that only deals single-target damage must clearly beat the free basic attack
    // (1.0x ATK), otherwise the new button would be a strictly worse choice.
    const stats = applyEnhance(battleStats(card), MAX_ENHANCE, card.rarity);
    for (const skill of skills) {
      const pure = skill.ability.ops.every((op) => op.op === 'damage');
      if (!pure || skill.ability.ops.length === 0) continue;
      const ops = skill.ability.ops as Array<{ power: number; hits?: number; target?: string }>;
      if (!ops.every((op) => (op.target ?? 'enemy_active') === 'enemy_active')) continue;
      const total = ops.reduce((sum, op) => sum + op.power * (op.hits ?? 1), 0);
      assert.ok(total >= stats.atk * 1.5, `${card.id} +${skill.level} paid burst ${total} vs ATK ${stats.atk}`);
    }
    // A pure team-wide nuke prints one number per enemy; each must still beat the DEF factor.
    for (const skill of skills) {
      const pure = skill.ability.ops.every((op) => op.op === 'damage');
      if (!pure || skill.ability.ops.length === 0) continue;
      const ops = skill.ability.ops as Array<{ power: number; hits?: number; target?: string }>;
      if (!ops.every((op) => (op.target ?? 'enemy_active') === 'enemy_all')) continue;
      assert.ok(ops[0]!.power >= stats.atk * 0.8, `${card.id} +${skill.level} AoE hit ${ops[0]!.power} vs ATK ${stats.atk}`);
    }
  }
  assert.equal(ids.size, 138);
  assert.equal(names.size, 138);
  assert.equal(allEnhanceSkillIdeas().length, 138);
});

test('enhance skills: seeds carry the unlocks and a signature scaled to the card stats', () => {
  const card = CARDS.find((candidate) => candidate.rarity === 'UR') ?? CARDS[0]!;
  assert.deepEqual(combatantSeed(card.id, 1, 0).skills, []);
  assert.deepEqual(combatantSeed(card.id, 1, 4).skills, []);
  assert.equal(combatantSeed(card.id, 1, 5).skills!.length, 1);
  assert.equal(combatantSeed(card.id, 1, 10).skills!.length, 2);
  assert.equal(combatantSeed(card.id, 1, 15).skills!.length, 3);

  // The base ability id never changes; only its flat numbers follow the stat curve.
  const raw = battleStats(card).ability;
  for (const level of [0, 5, 10, 15]) {
    const seed = combatantSeed(card.id, 1, level);
    assert.equal(seed.ability.id, raw.id, `${card.id} +${level}`);
    assert.deepEqual(seed.ability.ops, scaleAbility(raw, card.rarity, level).ops);
  }
  // Opponents never unlock skills, so the shared AI can never diverge from the client.
  const opponent = buildSetup({ kind: 'pve', opponentId: 'rookie', modifier: { kind: 'none' }, seed: 1, playerCardIds: CARD_IDS.slice(0, 3), playerEnhance: [15, 15, 15] });
  assert.ok(opponent.player.every((seed) => seed.skills!.length === 3));
  assert.ok(opponent.opponent.every((seed) => (seed.skills ?? []).length === 0));
});

test('enhance skills: scaling touches flat numbers only, never percentages, turns or energy', () => {
  const synthetic: Ability = {
    id: 'synthetic',
    name: 'synthetic',
    description: '',
    cost: 3,
    cooldown: 2,
    ops: [
      { op: 'damage', power: 100, target: 'enemy_active' },
      { op: 'heal', amount: 40, target: 'self' },
      { op: 'shield', amount: 30, target: 'self' },
      { op: 'apply_status', status: 'poison', turns: 3, value: 10, target: 'enemy_active' },
      { op: 'apply_status', status: 'stun', turns: 1, chance: 35, target: 'enemy_active' },
      { op: 'apply_status', status: 'def_down', turns: 2, value: 25, target: 'enemy_active' },
      { op: 'conditional', when: { selfHpBelow: 50 }, then: [{ op: 'damage', power: 60, target: 'enemy_active' }] }
    ]
  };
  const scale = enhanceScale('UR', 15);
  assert.ok(scale > 1);
  const scaled = scaleAbility(synthetic, 'UR', 15);
  assert.equal(scaled.cost, 3);
  assert.equal(scaled.cooldown, 2);
  assert.equal((scaled.ops[0] as { power: number }).power, Math.round(100 * scale));
  assert.equal((scaled.ops[1] as { amount: number }).amount, Math.round(40 * scale));
  assert.equal((scaled.ops[2] as { amount: number }).amount, Math.round(30 * scale));
  assert.equal((scaled.ops[3] as { value: number }).value, Math.round(10 * scale));
  // Chances, turn counts and atk/def percentages are rule values, not potency: left alone.
  assert.deepEqual(scaled.ops[4], synthetic.ops[4]);
  assert.deepEqual(scaled.ops[5], synthetic.ops[5]);
  assert.deepEqual((scaled.ops[6] as { then: unknown[] }).then, [{ op: 'damage', power: Math.round(60 * scale), target: 'enemy_active' }]);
  // Level 0 low rarity keeps its published behaviour (N scale is ~1).
  const untouched = scaleAbility(synthetic, 'N', 0);
  assert.equal((untouched.ops[0] as { power: number }).power, 100);
});

test('enhance skills: a forged or malformed skill id is rejected before any mutation', () => {
  const skill: Ability = { id: 'skill:test:5', name: '테스트 기술', description: '', cost: 2, cooldown: 0, ops: [{ op: 'damage', power: 5, target: 'enemy_active' }] };
  const state = createBattle(setup([unit('a0', 'a', 0, { skills: [skill] })]));
  assert.equal(state.activeUid, 'a0');
  const logLength = state.log.length;
  const draws = state.rngDraws;

  const forged = advance(state, { uid: 'a0', action: 'skill', skillId: 'skill:test:99' });
  assert.equal(forged.error, 'skill');
  assert.equal(forged.events.length, 0);
  assert.equal(state.log.length, logLength);
  assert.equal(state.rngDraws, draws);

  assert.equal(advance(state, { uid: 'a0', action: 'skill', skillId: 'x'.repeat(65) }).error, 'skill');
  assert.equal(advance(state, { uid: 'a0', action: 'skill', skillId: '' }).error, 'skill');
  assert.equal(advance(state, { uid: 'a0', action: 'skill', skillId: 7 as unknown as string }).error, 'skill');
  // An id on a plain attack is not silently ignored.
  assert.equal(advance(state, { uid: 'a0', action: 'attack', skillId: skill.id }).error, 'action');
  // The base skill id is not a shortcut into the addition list.
  assert.equal(advance(state, { uid: 'a0', action: 'skill', skillId: 'base:a0' }).error, 'skill');
  assert.equal(state.log.length, logLength);
});

test('enhance skills: energy and the shared cooldown follow the chosen skill, not the base', () => {
  const skill: Ability = { id: 'skill:test:15', name: '강화 기술', description: '', cost: 4, cooldown: 2, ops: [{ op: 'damage', power: 25, target: 'enemy_active' }] };
  const seed = unit('a0', 'a', 0, { skills: [skill] });
  const state = createBattle(setup([seed]));
  const before = state.sides.a[0]!;
  const energyBefore = before.energy;

  const result = advance(state, { uid: 'a0', action: 'skill', skillId: skill.id });
  assert.equal(result.error, undefined);
  const after = result.state.sides.a[0]!;
  // Cost comes from the chosen skill (4, not the base's 1) and the shared cooldown is set from it.
  assert.equal(after.energy, energyBefore - 4);
  assert.equal(after.cooldown, 2);
  assert.deepEqual(result.events.find((event) => event.t === 'action'), { t: 'action', uid: 'a0', action: 'skill', abilityName: '강화 기술' });
  // Using a skill never rewrites the base ability.
  assert.equal(after.ability.id, 'base:a0');
  assert.deepEqual(after.ability.ops, seed.ability.ops);

  // The one cooldown counter blocks every choice, base included.
  const cooling: typeof state = { ...state, sides: { a: [{ ...before, cooldown: 2 }], b: state.sides.b } };
  assert.equal(advance(cooling, { uid: 'a0', action: 'skill' }).error, 'cooldown');
  assert.equal(advance(cooling, { uid: 'a0', action: 'skill', skillId: skill.id }).error, 'cooldown');

  const drained: typeof state = { ...state, sides: { a: [{ ...before, energy: 0 }], b: state.sides.b } };
  assert.equal(advance(drained, { uid: 'a0', action: 'skill', skillId: skill.id }).error, 'energy');
  assert.equal(advance(drained, { uid: 'a0', action: 'skill' }).error, 'energy');
  // A free basic attack is always legal, whatever the pool says.
  assert.equal(advance(drained, { uid: 'a0', action: 'attack' }).error, undefined);
});

test('enhance skills: incremental stepBattle matches a full replay that used skill ids', () => {
  const playerCardIds = CARD_IDS.slice(0, 3);
  const built = buildSetup({ kind: 'pve', opponentId: 'rookie', modifier: { kind: 'none' }, seed: 99, playerCardIds, playerEnhance: [15, 15, 15] });
  const decider = deciderFor(opponentById(built.opponentId)!);

  let state = createBattle(built);
  const decisions: Decision[] = [];
  for (let step = 0; step < 60 && state.status === 'active'; step++) {
    const uid = state.activeUid;
    if (!uid) break;
    const actor = state.sides.a.find((combatant) => combatant.uid === uid);
    assert.ok(actor, 'stepBattle must hand control back on a player turn');
    const usable = actor.cooldown === 0 ? actor.skills.find((skill) => actor.energy >= skill.cost) : undefined;
    const decision: Decision = usable ? { uid, action: 'skill', skillId: usable.id } : { uid, action: 'attack' };
    const result = stepBattle(state, decision, decider);
    assert.equal(result.error, undefined);
    decisions.push(decision);
    state = result.state;
  }
  assert.ok(decisions.some((decision) => decision.skillId), 'the scripted run used an unlocked skill');

  const replay = runBattle(built, decisions, decider);
  assert.equal(replay.error, undefined);
  assert.deepEqual(replay.state, state);
  const skillName = decisions.find((decision) => decision.skillId)!.skillId;
  assert.ok(
    replay.state.log.some((event) => event.t === 'action' && event.action === 'skill' && event.abilityName),
    `skill ${skillName} is logged by name`
  );
});

test('enhance skills: enhanced snapshots are deterministic and additive', () => {
  for (const cardId of CARD_IDS) {
    const first = combatantSeed(cardId, 1, 10);
    assert.deepEqual(first, combatantSeed(cardId, 1, 10), cardId);
    assert.deepEqual(first.skills!.map((skill) => skill.id), unlockedSkills(CARDS.find((card) => card.id === cardId)!, 10).map((skill) => skill.ability.id));
    // The base ability stays put while the seed gains the unlock list.
    assert.equal(first.ability.id, combatantSeed(cardId, 1, 0).ability.id);
    assert.ok(first.skills!.every((skill) => skill.id !== first.ability.id));
  }
  const once = buildSetup({ kind: 'pve', opponentId: 'rookie', modifier: { kind: 'none' }, seed: 5, playerCardIds: CARD_IDS.slice(0, 3), playerEnhance: [15, 5, 0] });
  const twice = buildSetup({ kind: 'pve', opponentId: 'rookie', modifier: { kind: 'none' }, seed: 5, playerCardIds: CARD_IDS.slice(0, 3), playerEnhance: [15, 5, 0] });
  assert.deepEqual(once, twice);
  assert.deepEqual(createBattle(once), createBattle(twice));
});

test('enhance skills: combatant seeds reject an unknown card as before', () => {
  assert.throws(() => combatantSeed('nope-999', 1, 15));
});
