import assert from 'node:assert/strict';
import test from 'node:test';
import { kstDate, rarityRank, rollRarity } from '../lib/rules.ts';

test('KST reset and rarity boundaries stay stable', () => {
  assert.equal(kstDate(new Date('2026-08-23T14:59:59Z')), '2026-08-23');
  assert.equal(kstDate(new Date('2026-08-23T15:00:00Z')), '2026-08-24');
  assert.equal(rollRarity(0.49), 'N');
  assert.equal(rollRarity(0.5), 'R');
  assert.equal(rollRarity(0.99), 'UR');
  assert.ok(rarityRank('UR') < rarityRank('SSR'));
  assert.ok(rarityRank('SSR') < rarityRank('N'));
});
