import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';
import { ABILITY_RULESET, CURATED_ABILITIES, abilityFor, validateAbility, validateAllAbilities } from '../lib/battle/abilities.ts';
import { DEFAULT_OPPONENT_ID, OPPONENTS, opponentById } from '../lib/battle/opponents.ts';
import { RARITY_COST, STAT_RULESET, battleStats, elementOf } from '../lib/battle/stats.ts';
import { ELEMENTS } from '../lib/battle/types.ts';
import { enhancePower } from '../lib/enhance.ts';

const cards = manifest.cards as Card[];
const byId = new Map(cards.map((card) => [card.id, card]));
const cardById = (id: string): Card => {
  const card = byId.get(id);
  assert.ok(card, `unknown card ${id}`);
  return card;
};
const POWER_ANCHOR = 180;

test('stats: rarity-normalized derivation matches the documented power anchors', () => {
  assert.equal(cards.length, 46);
  for (const card of cards) {
    const stats = battleStats(card);
    assert.ok(Number.isInteger(stats.maxHp) && stats.maxHp > 0, `${card.id} maxHp ${stats.maxHp}`);
    assert.ok(stats.atk >= 1 && stats.def >= 1, card.id);
    assert.equal(stats.spd, 10 + Math.floor(card.luck / 4), card.id);
    assert.ok(stats.spd >= 10 && stats.spd <= 35, `${card.id} spd`);
    assert.ok(stats.crit >= 5 && stats.crit <= 15, `${card.id} crit`);
    assert.ok(ELEMENTS.includes(stats.element), `${card.id} element ${stats.element}`);
    assert.equal(stats.cost, RARITY_COST[card.rarity], card.id);
  }
  // The rarity's MEAN derived power (HP + 2*ATK + DEF) sits on 180 * POWER_CURVE(rarity, 0), which
  // is what makes N5=R3=SR0 and friends line up once the enhance curve is applied.
  for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR'] as const) {
    const pool = cards.filter((card) => card.rarity === rarity).map(battleStats);
    const mean = pool.reduce((sum, stats) => sum + stats.maxHp + stats.atk * 2 + stats.def, 0) / pool.length;
    const target = POWER_ANCHOR * enhancePower(rarity, 0);
    assert.ok(Math.abs(mean - target) / target < 0.15, `${rarity} mean ${mean.toFixed(1)} vs ${target.toFixed(1)}`);
  }
  // Higher rarity buys more raw power at the same level; low rarity is never the stronger one.
  const meanOf = (rarity: Card['rarity']) => {
    const pool = cards.filter((card) => card.rarity === rarity).map(battleStats);
    return pool.reduce((sum, stats) => sum + stats.maxHp + stats.atk * 2 + stats.def, 0) / pool.length;
  };
  const ladder = (['N', 'R', 'SR', 'SSR', 'UR'] as const).map(meanOf);
  for (let index = 1; index < ladder.length; index++) assert.ok(ladder[index]! > ladder[index - 1]!);
});

test('stats: ability identity is stable and keeps the curated Korean copy', () => {
  assert.equal(STAT_RULESET, 6);
  assert.equal(ABILITY_RULESET, 3);
  for (const card of cards) {
    const { ability } = battleStats(card);
    assert.equal(ability.id, `ability:${card.id}@${ABILITY_RULESET}`, card.id);
    assert.equal(ability.name, card.skillName, card.id);
    assert.equal(ability.description, card.skillDescription, card.id);
    assert.equal(ability.cost, RARITY_COST[card.rarity], card.id);
    assert.equal(ability.ops.length > 0, true, card.id);
  }
  assert.ok(Object.keys(CURATED_ABILITIES).length <= 6);
  assert.deepEqual(battleStats(cardById('imsingyu-v033')).ability.ops, CURATED_ABILITIES['imsingyu-v033']!.ops);
});

test('stats: derivation is deterministic across calls and a fresh manifest parse', async () => {
  for (const card of cards) {
    assert.deepEqual(battleStats(card), battleStats(card), card.id);
    assert.deepEqual(elementOf(card), elementOf(card), card.id);
  }
  const reread = JSON.parse(await readFile(path.join(process.cwd(), 'lib', 'data', 'cards.curated.json'), 'utf8')) as {
    cards: Card[];
  };
  assert.deepEqual(reread.cards.map(battleStats), cards.map(battleStats));
  assert.deepEqual(reread.cards.map(abilityFor), cards.map(abilityFor));
});

test('abilities: all 46 derived abilities validate and ids are unique', () => {
  assert.deepEqual(validateAllAbilities(cards), []);
  const ids = cards.map((card) => abilityFor(card).id);
  assert.equal(new Set(ids).size, cards.length);
});

test('abilities: malformed input is rejected per failure class without throwing', () => {
  const valid = abilityFor(cardById('imsingyu-v002'));
  const check = (label: string, input: unknown) => {
    const result = validateAbility(input);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.length > 0, label);
    assert.equal(result.ability, undefined, label);
  };

  const baseline = validateAbility(valid);
  assert.equal(baseline.ok, true);
  assert.deepEqual(baseline.ability, valid);

  check('missing ops', { ...valid, ops: undefined });
  check('empty ops', { ...valid, ops: [] });
  check('too many ops', { ...valid, ops: Array.from({ length: 9 }, () => ({ op: 'heal', amount: 1 })) });
  check('unknown op', { ...valid, ops: [{ op: 'delete_everything', power: 1 }] });
  check('unknown status', { ...valid, ops: [{ op: 'apply_status', status: 'burn', turns: 1 }] });
  check('negative power', { ...valid, ops: [{ op: 'damage', power: -5 }] });
  check('non-integer hits', { ...valid, ops: [{ op: 'damage', power: 5, hits: 2.5 }] });
  check('unknown target', { ...valid, ops: [{ op: 'damage', power: 5, target: 'enemy_everything' }] });
  check('cost too high', { ...valid, cost: 11 });
  check('cost negative', { ...valid, cost: -1 });
  check('cooldown too high', { ...valid, cooldown: 6 });
  check('non-integer cost', { ...valid, cost: 1.5 });
  check('nested conditional', {
    ...valid,
    ops: [{ op: 'conditional', when: { turnAtLeast: 1 }, then: [{ op: 'conditional', when: { turnAtLeast: 1 }, then: [{ op: 'damage', power: 1 }] }] }]
  });
  check('unknown condition', { ...valid, ops: [{ op: 'conditional', when: { moonPhase: 1 }, then: [{ op: 'damage', power: 1 }] }] });
  check('empty conditional then', { ...valid, ops: [{ op: 'conditional', when: { turnAtLeast: 1 }, then: [] }] });
  check('missing when', { ...valid, ops: [{ op: 'conditional', then: [{ op: 'damage', power: 1 }] }] });

  for (const junk of [null, undefined, 42, 'damage', [], [1, 2], { ops: [valid.ops[0]] }, { id: '', name: '', description: '', cost: 1, cooldown: 0, ops: [null] }]) {
    const result = validateAbility(junk);
    assert.equal(result.ok, false, JSON.stringify(junk));
    assert.ok(result.errors.length > 0);
  }
});

test('opponents: five distinct ladders over real manifest cards', () => {
  assert.equal(OPPONENTS.length, 5);
  assert.deepEqual(
    OPPONENTS.map((opponent) => opponent.id),
    ['rookie', 'regular', 'veteran', 'ace', 'boss']
  );
  assert.deepEqual(
    OPPONENTS.map((opponent) => opponent.reward.credits),
    [2, 3, 4, 5, 8]
  );
  assert.deepEqual(
    OPPONENTS.map((opponent) => opponent.difficulty),
    ['beginner', 'normal', 'normal', 'hard', 'boss']
  );
  assert.equal(DEFAULT_OPPONENT_ID, 'rookie');
  assert.equal(opponentById('rookie')?.id, 'rookie');
  assert.equal(opponentById('nope'), undefined);

  for (const opponent of OPPONENTS) {
    assert.equal(opponent.cards.length, 3, opponent.id);
    assert.equal(new Set(opponent.cards).size, 3, opponent.id);
    for (const cardId of opponent.cards) assert.ok(byId.has(cardId), `${opponent.id} references unknown card ${cardId}`);
    assert.ok(opponent.hpScale >= 0.9 && opponent.hpScale <= 1.25, opponent.id);
    assert.ok(opponent.reward.label.length > 0, opponent.id);
  }

  assert.equal(new Set(OPPONENTS.map((opponent) => JSON.stringify(opponent.profile))).size, 5);
  assert.equal(new Set(OPPONENTS.map((opponent) => JSON.stringify(opponent.cards))).size, 5);

  const baseRookie = OPPONENTS.find((opponent) => opponent.id === DEFAULT_OPPONENT_ID)!;
  const baseBoss = OPPONENTS.find((opponent) => opponent.id === 'boss')!;
  const rookie = opponentById(DEFAULT_OPPONENT_ID);
  const boss = opponentById('boss');
  assert.ok(rookie);
  assert.ok(boss);
  assert.ok(rookie.cards.every((cardId) => ['N', 'R'].includes(cardById(cardId).rarity)));
  assert.equal(boss.profile.skillAppetite, Math.max(...OPPONENTS.map((opponent) => opponent.profile.skillAppetite)));
  assert.equal(baseBoss.hpScale, Math.max(...OPPONENTS.map((opponent) => opponent.hpScale)));
  assert.ok(Math.abs(boss.hpScale - baseBoss.hpScale * 1.12 * 1.2) < 1e-9);
  assert.equal(boss.reward.credits, Math.max(...OPPONENTS.map((opponent) => opponent.reward.credits)));
  const ranks: Record<Card['rarity'], number> = { N: 0, R: 1, SR: 2, SSR: 3, UR: 4, XR: 5 };
  const bossRanks = boss.cards.map((cardId) => ranks[cardById(cardId).rarity]);
  assert.deepEqual(bossRanks, [4, 3, 3]);
  assert.equal(baseRookie.hpScale, Math.min(...OPPONENTS.map((opponent) => opponent.hpScale)));
  assert.equal(new Set(OPPONENTS.map((opponent) => opponent.hpScale)).size, 5);
});

test('rarity fairness: cheap decks keep tempo instead of raw stats', () => {
  const costs = cards.map((card) => battleStats(card).cost).sort((a, b) => a - b);
  const cheapest = costs.slice(0, 3).reduce((sum, cost) => sum + cost, 0);
  const priciest = costs.slice(-3).reduce((sum, cost) => sum + cost, 0);
  assert.ok(cheapest < priciest, `cheapest ${cheapest} vs priciest ${priciest}`);
  assert.deepEqual(
    cards
      .filter((card) => battleStats(card).cost === costs[0])
      .map((card) => card.rarity)
      .every((rarity) => rarity === 'N'),
    true
  );

  const spds = cards.map((card) => battleStats(card).spd).sort((a, b) => a - b);
  const median = spds[Math.floor(spds.length / 2)] ?? 0;
  const fastCheap = cards.filter((card) => ['N', 'R'].includes(card.rarity) && battleStats(card).spd > median);
  assert.ok(fastCheap.length > 0, 'a N/R card must out-speed the median');

  const cheapPool = cards.filter((card) => ['N', 'R'].includes(card.rarity));
  assert.ok(new Set(cheapPool.map((card) => battleStats(card).element)).size >= 3, 'cheap decks must cover several elements');

  const rookie = opponentById(DEFAULT_OPPONENT_ID);
  assert.ok(rookie);
  const rookieHp = rookie.cards.reduce((sum, cardId) => sum + battleStats(cardById(cardId)).maxHp * rookie.hpScale, 0);
  const bestNDeckHp = cards
    .filter((card) => card.rarity === 'N')
    .map((card) => battleStats(card).maxHp)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, hp) => sum + hp, 0);
  assert.ok(bestNDeckHp > rookieHp, `N deck ${bestNDeckHp} vs rookie ${rookieHp}`);
});
