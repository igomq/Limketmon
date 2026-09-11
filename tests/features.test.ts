// The three extension features: the card battle profile, the record screen's replay list, and
// the auto-filled deck.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const USER = 'feature_user';
const db = createD1();
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;
const game = await import('../lib/game.ts');
const { battleStats } = await import('../lib/battle/stats.ts');
const { ELEMENT_LABEL, STATUS_LABEL } = await import('../lib/battle/types.ts');
const { cardIdsByRarity, seedOwned } = await import('./helpers/seed.ts');
const manifest = (await import('../lib/data/cards.curated.json', { with: { type: 'json' } })).default;

const DAY = new Date('2026-09-10T03:00:00Z');

function reset() {
  for (const table of ['reward_claims', 'user_achievements', 'battles', 'deck_cards', 'decks', 'inventory', 'pull_history', 'coupon_redemptions', 'user_game_state', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('${USER}', 'f@local.invalid', 'now', 'now')`);
  db.exec(`INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, pity_counter) VALUES ('${USER}', 0, NULL, 0)`);
}

test('the card battle profile is complete and human-readable for every card', () => {
  const labels = new Set(Object.values(ELEMENT_LABEL));
  for (const card of manifest.cards) {
    const stats = battleStats(card);
    assert.ok(Number.isInteger(stats.maxHp) && stats.maxHp > 0, card.id);
    assert.ok(labels.has(ELEMENT_LABEL[stats.element]), `${card.id} has no readable element label`);
    assert.ok(Number.isInteger(stats.cost) && stats.cost >= 0, card.id);
    // Every ability op the sheet prints must have a Korean status label behind it.
    for (const op of stats.ability.ops) {
      if (op.op === 'apply_status' || op.op === 'modify_stat') {
        assert.ok(STATUS_LABEL[op.status], `${card.id} status ${op.status} has no label`);
      }
      if (op.op === 'conditional') assert.ok(op.then.length > 0, card.id);
    }
    assert.ok(stats.ability.description.length > 0, `${card.id} ability needs copy for the sheet`);
  }
});

test('the record screen lists recent battles and they are all replayable', async () => {
  reset();
  const owned = cardIdsByRarity({ R: 3 });
  seedOwned(db, USER, owned);
  const deck = (await game.createDeck(USER, '기록 덱', owned)).find((entry) => entry.name === '기록 덱')!;
  for (let index = 0; index < 2; index++) {
    const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, DAY);
    const played = await play(setup);
    await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
  }

  const snapshot = await game.getSnapshot(USER, DAY);
  assert.equal(snapshot.recentBattles.length, 2, 'settled battles appear in the list');
  const [newest] = snapshot.recentBattles;
  assert.ok(newest!.id && newest!.opponentName && newest!.kstDate, 'the row carries what the list shows');
  assert.ok(['won', 'lost', 'draw'].includes(newest!.result));
  // A pending battle must never surface in the list.
  await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, DAY);
  assert.equal((await game.getSnapshot(USER, DAY)).recentBattles.length, 2, 'pending battles stay out');

  for (const row of snapshot.recentBattles) {
    const replay = await game.replayBattle(USER, row.id);
    assert.equal(replay.verified, true, `${row.id} replays to its stored result`);
    assert.ok(replay.events.length > 0);
  }
});

test('auto deck picks the strongest owned cards and never invents cards', async () => {
  reset();
  const weak = cardIdsByRarity({ N: 3 });
  const strong = cardIdsByRarity({ UR: 1, SSR: 1 });
  seedOwned(db, USER, [...weak, ...strong]);

  const decks = await game.autoDeck(USER);
  const made = decks.find((entry) => entry.name === '추천 덱');
  assert.ok(made, 'a recommendation deck is created when none is given');
  assert.equal(made!.cards.length, 3);
  for (const cardId of made!.cards) {
    assert.ok([...weak, ...strong].includes(cardId), 'only owned cards are used');
  }
  assert.ok(made!.cards.includes(strong[0]!) && made!.cards.includes(strong[1]!), 'the strongest cards make it in');
  assert.equal(new Set(made!.cards).size, 3, 'no duplicates');

  // Refilling an existing deck replaces its cards in place.
  const refilled = await game.autoDeck(USER, made!.id);
  assert.equal(refilled.find((entry) => entry.id === made!.id)!.cards.length, 3);
  assert.equal(refilled.filter((entry) => entry.name === '추천 덱').length, 1, 'refill does not create a second deck');

  // Deterministic: the same collection always yields the same three cards.
  await game.autoDeck(USER, made!.id);
  const again = (await game.listDecks(USER)).find((entry) => entry.id === made!.id)!;
  assert.deepEqual(again.cards, made!.cards);
});

test('auto deck refuses politely when the collection is too small', async () => {
  reset();
  seedOwned(db, USER, cardIdsByRarity({ N: 2 }));
  await assert.rejects(game.autoDeck(USER), /3장 필요/);
});

/** Plays a started battle with the shared engine, preferring skills and falling back to attacks. */
function play(setup: Awaited<ReturnType<typeof game.startBattle>>) {
  return import('../lib/battle/setup.ts').then(async ({ buildSetup }) => {
    const { advance, createBattle } = await import('../lib/battle/engine.ts');
    const { aiDecision } = await import('../lib/battle/ai.ts');
    const { opponentById } = await import('../lib/battle/opponents.ts');
    const full = buildSetup({
      kind: setup.kind,
      opponentId: setup.opponentId,
      modifier: setup.modifier,
      seed: setup.seed,
      playerCardIds: setup.player.map((entry) => entry.cardId),
      playerEnhance: setup.player.map((entry: { enhance?: number }) => entry.enhance ?? 0),
      battleId: setup.battleId
    });
    const profile = opponentById(setup.opponentId)!.profile;
    let state = createBattle(full);
    const decisions: Array<{ uid: string; action: 'attack' | 'skill' }> = [];
    for (let step = 0; step < 500 && state.status === 'active'; step++) {
      const uid = state.activeUid;
      if (!uid) break;
      const isPlayer = uid.startsWith('a');
      let action: 'attack' | 'skill' = isPlayer ? 'skill' : aiDecision(state, profile).action;
      let result = advance(state, { uid, action });
      if (result.error) {
        action = 'attack';
        result = advance(state, { uid, action });
      }
      if (result.error) break;
      state = result.state;
      if (isPlayer) decisions.push({ uid, action });
    }
    return { decisions, result: state.status };
  });
}
