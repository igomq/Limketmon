import assert from 'node:assert/strict';
import test from 'node:test';
import {
  kstDate,
  LOW_RARITY_WEIGHTS,
  PULL_ODDS,
  RARITY_ORDER,
  RARITY_WEIGHTS,
  rarityRank,
  rollGuaranteedRarity,
  rollRarity
} from '../lib/rules.ts';

test('KST reset and the flat pull tables stay stable', () => {
  assert.equal(kstDate(new Date('2026-08-23T14:59:59Z')), '2026-08-23');
  assert.equal(kstDate(new Date('2026-08-23T15:00:00Z')), '2026-08-24');

  // Normal table: N60 R28 SR10 SSR1.9 UR0.1.
  assert.equal(rollRarity(0.599999), 'N');
  assert.equal(rollRarity(0.6), 'R');
  assert.equal(rollRarity(0.879999), 'R');
  assert.equal(rollRarity(0.88), 'SR');
  assert.equal(rollRarity(0.979999), 'SR');
  assert.equal(rollRarity(0.98), 'SSR');
  assert.equal(rollRarity(0.998999), 'SSR');
  assert.equal(rollRarity(0.999), 'UR');

  // Low table: N78 R20 SR1.9 SSR0.1, and never a UR.
  assert.equal(rollRarity(0.779999, 'low'), 'N');
  assert.equal(rollRarity(0.78, 'low'), 'R');
  assert.equal(rollRarity(0.979999, 'low'), 'R');
  assert.equal(rollRarity(0.98, 'low'), 'SR');
  assert.equal(rollRarity(0.999, 'low'), 'SSR');
  assert.equal(rollRarity(0.999999, 'low'), 'SSR');
});

test('XR is ranked but never drawn from a pull table', () => {
  assert.equal(RARITY_ORDER[0], 'XR');
  assert.ok(rarityRank('XR') < rarityRank('UR'));
  assert.ok(rarityRank('UR') < rarityRank('SSR'));
  assert.ok(rarityRank('SSR') < rarityRank('N'));
  for (const table of [RARITY_WEIGHTS, LOW_RARITY_WEIGHTS]) {
    assert.ok(!table.some(([rarity]) => rarity === 'XR'));
  }
  for (let index = 0; index < 1000; index++) {
    assert.notEqual(rollRarity(index / 1000, 'normal'), 'XR');
    assert.notEqual(rollRarity(index / 1000, 'low'), 'XR');
  }
});

test('every pull table sums to exactly one', () => {
  for (const [kind, table] of Object.entries(PULL_ODDS)) {
    const total = table.reduce((sum, [, weight]) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `${kind} table sums to ${total}`);
  }
});

test('guaranteed tickets normalise the base weights among the allowed rarities', () => {
  // SR+ renormalises SR/SSR/UR = 0.1/0.019/0.001 → cumulative 0.8333 / 0.9917 / 1.
  assert.equal(rollGuaranteedRarity(0.8, 'SR'), 'SR');
  assert.equal(rollGuaranteedRarity(0.93, 'SR'), 'SR');
  assert.equal(rollGuaranteedRarity(0.95, 'SR'), 'SSR');
  assert.equal(rollGuaranteedRarity(0.9999, 'SR'), 'UR');
  // SSR+ renormalises SSR/UR = 0.019/0.001 → 0.95 / 1.
  assert.equal(rollGuaranteedRarity(0.9, 'SSR'), 'SSR');
  assert.equal(rollGuaranteedRarity(0.96, 'SSR'), 'UR');
  for (const unit of [0.999999, 0.5, 0.2]) {
    assert.ok(['SR', 'SSR', 'UR'].includes(rollGuaranteedRarity(unit, 'SR')));
  }
});
