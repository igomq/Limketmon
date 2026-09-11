import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { applyEnhance, canEnhance, clampEnhance, enhanceCost, enhanceMaterials, enhancePower, MAX_ENHANCE, parseDeckSlots } from '../lib/enhance.ts';
import { battleStats } from '../lib/battle/stats.ts';
import { createD1, migrate } from './helpers/d1.mjs';
import { cardIdsByRarity, seedOwned } from './helpers/seed.ts';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';
import type { Rarity } from '../lib/rules.ts';

const cards = manifest.cards as Card[];

test('enhance cost starts at 1 and climbs one extra copy per level', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(enhanceCost), [1, 2, 3, 4, 5]);
  assert.equal(canEnhance(2, 0), true);
  assert.equal(canEnhance(1, 0), false);
  assert.equal(canEnhance(3, 1), true);
  assert.equal(canEnhance(2, 1), false);
  assert.equal(canEnhance(99, MAX_ENHANCE), false);
  assert.equal(clampEnhance(-2), 0);
  assert.equal(clampEnhance(99), MAX_ENHANCE);
  assert.equal(MAX_ENHANCE, 15);
});

test('enhanceMaterials keeps one base copy and canEnhance agrees at the boundaries', () => {
  // Displayed material count is total minus the one base copy that is never spent.
  assert.equal(enhanceMaterials(1), 0);
  assert.equal(enhanceMaterials(3), 2);
  assert.equal(enhanceMaterials(4), 3);
  assert.equal(enhanceMaterials(6), 5);
  assert.equal(enhanceMaterials(0), 0);
  assert.equal(enhanceMaterials(-4), 0);
  // +3 costs three materials, so three total copies (two materials) cannot do it.
  assert.equal(canEnhance(3, 2), false);
  assert.equal(canEnhance(4, 2), true);
  assert.equal(canEnhance(6, 2), true);
});

test('enhancePower hits the documented landmarks within 15% and grows strictly', () => {
  // N/R still share the old bands. SR/SSR/UR sit 3/6/10% above them; XR is UR * 1.35.
  const near = (left: number, right: number, label: string) => {
    assert.ok(Math.abs(left - right) / right <= 0.15, `${label}: ${left} vs ${right}`);
  };
  near(enhancePower('N', 5), enhancePower('R', 3), 'N5~R3');
  near(enhancePower('N', 5), 1.55, 'N5~old SR0');
  near(enhancePower('SR', 0), 1.55 * 1.03, 'SR0 is +3%');
  assert.equal(enhancePower('N', 10), 2.4);
  assert.equal(enhancePower('R', 5), 2.075);
  near(enhancePower('SSR', 0), 2.4 * 1.06, 'SSR0 is +6%');
  near(enhancePower('UR', 0), 3.55 * 1.1, 'UR0 is +10%');
  near(enhancePower('XR', 0), enhancePower('UR', 0) * 1.35, 'XR is UR*1.35');
  assert.ok(enhancePower('SR', 0) > 1.55);
  assert.ok(enhancePower('SSR', 0) > 2.4);
  assert.ok(enhancePower('UR', 0) > 3.55);
  for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR', 'XR'] as const) {
    for (let level = 0; level < MAX_ENHANCE; level++) {
      assert.ok(enhancePower(rarity, level + 1) > enhancePower(rarity, level), `${rarity}@${level}`);
    }
  }
});

test('applyEnhance scales combat stats by the rarity curve and parseDeckSlots reads old snapshots', () => {
  const card = cards.find((entry) => entry.rarity === 'SR')!;
  const base = battleStats(card);
  const level = 6;
  const mul = enhancePower('SR', level) / enhancePower('SR', 0);
  const boosted = applyEnhance(base, level, card.rarity);
  assert.equal(boosted.maxHp, Math.round(base.maxHp * mul));
  assert.equal(boosted.atk, Math.round(base.atk * mul));
  assert.equal(boosted.def, Math.round(base.def * mul));
  assert.equal(boosted.crit, base.crit + Math.floor(level / 3));
  // Level 0 is an identity, and the default rarity keeps the N curve.
  assert.deepEqual(applyEnhance(base, 0, card.rarity), base);
  assert.deepEqual(applyEnhance(base, 0), base);
  assert.deepEqual(parseDeckSlots('["imsingyu-v001","imsingyu-v002"]'), [
    { id: 'imsingyu-v001', enhance: 0 },
    { id: 'imsingyu-v002', enhance: 0 }
  ]);
  assert.deepEqual(parseDeckSlots('[{"id":"imsingyu-v001","lv":2}]'), [{ id: 'imsingyu-v001', enhance: 2 }]);
});

const USER = 'enhance_user';
const db = createD1();
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;
const game = await import('../lib/game.ts');

test('enhancing consumes copies, keeps one, and the battle snapshot uses the new level', async () => {
  db.exec('DELETE FROM deck_cards');
  db.exec('DELETE FROM decks');
  db.exec('DELETE FROM inventory');
  db.exec('DELETE FROM battles');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM user_game_state');
  db.exec("INSERT INTO users (id, email, created_at, updated_at) VALUES ('enhance_user', 'e@local.invalid', 'now', 'now')");
  db.exec("INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, pity_counter) VALUES ('enhance_user', 0, NULL, 0)");

  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  seedOwned(db, USER, [owned[0]!, owned[0]!, owned[0]!]);

  const before = await game.getSnapshot(USER);
  const item = before.inventory.find((entry) => entry.cardId === owned[0]);
  assert.ok(item);
  assert.equal(item.enhanceLevel, 0);
  assert.ok(item.quantity >= 4);

  const after = await game.enhanceCard(USER, owned[0]);
  const updated = after.inventory.find((entry) => entry.cardId === owned[0]);
  assert.ok(updated);
  assert.equal(updated.enhanceLevel, 1);
  assert.equal(updated.quantity, item.quantity - 1);

  await assert.rejects(game.enhanceCard(USER, 'nope'), (error: unknown) => error instanceof game.GameError && error.code === 'not_owned');

  const deck = (await game.createDeck(USER, '강화 덱', owned)).find((entry) => entry.name === '강화 덱')!;
  const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, new Date('2026-09-10T03:00:00Z'));
  const card = cards.find((entry) => entry.id === owned[0])!;
  const expected = applyEnhance(battleStats(card), 1, card.rarity);
  assert.equal(setup.player[0]!.enhance, 1);
  const role = setup.player[0]!.position;
  const bulk = role === 'healer' || role === 'tank' ? 1.1 : 1;
  assert.equal(setup.player[0]!.atk, Math.round(expected.atk * (role === 'dealer' ? 1.05 : 1)));
  assert.equal(setup.player[0]!.def, Math.round(expected.def * bulk));
  assert.equal(setup.player[0]!.maxHp, Math.round(expected.maxHp * bulk));
});

test('spending three materials from four copies keeps the base, and a shortfall is reported', async () => {
  db.exec('DELETE FROM deck_cards');
  db.exec('DELETE FROM decks');
  db.exec('DELETE FROM inventory');
  const ids = cardIdsByRarity({ N: 2 });
  const rich = ids[0]!;
  const poor = ids[1]!;

  // Four copies at +2: three materials, so +3 spends them all and leaves the base copy.
  seedOwned(db, USER, [rich, rich, rich, rich]);
  db.exec(`UPDATE inventory SET enhance_level = 2 WHERE user_id = '${USER}' AND card_id = '${rich}'`);
  const after = await game.enhanceCard(USER, rich);
  const item = after.inventory.find((entry) => entry.cardId === rich)!;
  assert.equal(item.enhanceLevel, 3);
  assert.equal(item.quantity, 1, 'the base copy stays');

  // Three copies at +2: only two materials, so +3 must fail naming the one-material deficit.
  seedOwned(db, USER, [poor, poor, poor]);
  db.exec(`UPDATE inventory SET enhance_level = 2 WHERE user_id = '${USER}' AND card_id = '${poor}'`);
  await assert.rejects(game.enhanceCard(USER, poor), /강화 재료가 1장 부족/);
});
