import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { applyEnhance, canEnhance, clampEnhance, enhanceCost, MAX_ENHANCE, parseDeckSlots } from '../lib/enhance.ts';
import { battleStats } from '../lib/battle/stats.ts';
import { createD1, migrate } from './helpers/d1.mjs';
import { cardIdsByRarity, seedOwned } from './helpers/seed.ts';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';

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
});

test('applyEnhance scales combat stats and parseDeckSlots reads old snapshots', () => {
  const card = cards[0]!;
  const base = battleStats(card);
  const boosted = applyEnhance(base, 2);
  assert.equal(boosted.maxHp, Math.round(base.maxHp * 1.16));
  assert.equal(boosted.atk, Math.round(base.atk * 1.16));
  assert.equal(boosted.def, Math.round(base.def * 1.16));
  assert.equal(boosted.crit, base.crit + 1);
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
  db.exec('DELETE FROM inventory');
  db.exec('DELETE FROM decks');
  db.exec('DELETE FROM deck_cards');
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

  await assert.rejects(game.enhanceCard(USER, 'nope'), /찾을 수 없습니다/);

  const deck = (await game.createDeck(USER, '강화 덱', owned)).find((entry) => entry.name === '강화 덱')!;
  const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, new Date('2026-09-10T03:00:00Z'));
  const card = cards.find((entry) => entry.id === owned[0])!;
  const expected = applyEnhance(battleStats(card), 1);
  assert.equal(setup.player[0]!.enhance, 1);
  assert.equal(setup.player[0]!.atk, expected.atk);
  assert.equal(setup.player[0]!.def, expected.def);
  assert.equal(setup.player[0]!.maxHp, expected.maxHp);
});
