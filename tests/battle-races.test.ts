// Regression tests for the concurrency holes an adversarial audit found: parallel-pull credit
// overdraw, the starter-deck race that turned a committed pull into a 503, the deck cap, daily
// reward banking across KST midnight, and unbounded pending battles.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const USER = 'race_user';
const db = createD1();
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;
const game = await import('../lib/game.ts');
const { kstDate } = await import('../lib/rules.ts');
const { buildSetup } = await import('../lib/battle/setup.ts');
const { advance, createBattle } = await import('../lib/battle/engine.ts');
const { aiDecision } = await import('../lib/battle/ai.ts');
const { opponentById } = await import('../lib/battle/opponents.ts');
const { cardIdsByRarity, seedOwned } = await import('./helpers/seed.ts');

const DAY = new Date('2026-09-10T03:00:00Z');

function reset() {
  for (const table of ['reward_claims', 'user_achievements', 'battles', 'deck_cards', 'decks', 'inventory', 'pull_history', 'coupon_redemptions', 'user_game_state', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('${USER}', 'r@local.invalid', 'now', 'now')`);
  db.exec(`INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, pity_counter) VALUES ('${USER}', 0, NULL, 0)`);
}

test('parallel pulls each charge one credit and can never overdraw the pool', async () => {
  reset();
  // Today's free pull is already spent, so every successful pull costs exactly one credit. The
  // balance only covers four of these, so the rest must be refused inside their transaction.
  await db.prepare('UPDATE user_game_state SET pull_credits = 4, last_free_pull_date = ? WHERE user_id = ?')
    .bind(kstDate(new Date()), USER)
    .run();
  const settled = await Promise.all(Array.from({ length: 10 }, () => game.pullCards(USER, 1).catch(() => null)));
  const reported = settled.filter(Boolean).length;
  assert.ok(reported > 0 && reported <= 4, `only the affordable pulls settle (${reported})`);

  const history = (await db.prepare('SELECT rarity FROM pull_history WHERE user_id = ?').bind(USER).all()).results as Array<{ rarity: string }>;
  assert.equal(history.length, reported, 'every reported pull is also stored');
  assert.equal(await creditsOf(USER), 4 - reported, 'one charge per settled pull, never negative');
});

async function creditsOf(userId: string): Promise<number> {
  const row = (await db.prepare('SELECT pull_credits FROM user_game_state WHERE user_id = ?').bind(userId).first()) as { pull_credits: number };
  return Number(row.pull_credits);
}

test('a concurrent read cannot make a committed pull fail or double-create starter decks', async () => {
  reset();
  // Three cards is exactly the moment the starter deck gets seeded, so a pull and a state read
  // can both try it at once.
  seedOwned(db, USER, cardIdsByRarity({ N: 2 }));
  // Consume the free pull first: a count-1 pull is free until today's date is recorded.
  await db.prepare('UPDATE user_game_state SET pull_credits = 20, last_free_pull_date = ? WHERE user_id = ?').bind(kstDate(new Date()), USER).run();
  const [pull, snapshot, second] = await Promise.all([
    game.pullCards(USER, 1),
    game.getSnapshot(USER, DAY),
    game.getSnapshot(USER, DAY)
  ]);
  assert.equal(pull.results.length, 1, 'the pull still reports its card');
  assert.equal(snapshot.decks.length <= 1 && second.decks.length <= 1, true, 'at most one starter deck');
  const decks = await db.prepare('SELECT COUNT(*) AS c FROM decks WHERE user_id = ?').bind(USER).first() as { c: number };
  assert.equal(Number(decks.c), 1);
  const credits = await db.prepare('SELECT pull_credits FROM user_game_state WHERE user_id = ?').bind(USER).first() as { pull_credits: number };
  assert.equal(Number(credits.pull_credits), 19, 'exactly one charge for one pull');
});

test('the deck cap holds when decks are created in parallel', async () => {
  reset();
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  const attempts = await Promise.allSettled(
    Array.from({ length: 14 }, (_value, index) => game.createDeck(USER, `덱 ${index}`, owned))
  );
  const rows = await db.prepare('SELECT COUNT(*) AS c FROM decks WHERE user_id = ?').bind(USER).first() as { c: number };
  assert.equal(Number(rows.c) <= 10, true, 'never more than the cap');
  assert.ok(attempts.some((entry) => entry.status === 'rejected'), 'the cap actually rejects');
  const defaults = await db.prepare('SELECT COUNT(*) AS c FROM decks WHERE user_id = ? AND is_default = 1').bind(USER).first() as { c: number };
  assert.equal(Number(defaults.c), 1, 'exactly one default deck');
});

test('a daily reward belongs to the day the challenge was issued', async () => {
  reset();
  seedOwned(db, USER, cardIdsByRarity({ N: 3, R: 3, SR: 2, SSR: 1, UR: 1 }));
  // R cards: strong enough to actually win the daily, and inside the R cap that 2026-09-10 uses.
  const owned = cardIdsByRarity({ R: 3 });
  const deck = (await game.createDeck(USER, '뱅킹 덱', owned)).find((entry) => entry.name === '뱅킹 덱')!;
  // Open the battle on one KST day and settle it on the next.
  const setup = await game.startBattle(USER, { deckId: deck.id, kind: 'daily' }, DAY);
  const played = play(setup);
  const nextDay = new Date(DAY.getTime() + 86_400_000);
  assert.notEqual(kstDate(DAY), kstDate(nextDay));
  // The seed is server-side, so keep opening battles until a win exercises the payout path.
  let summary = await game.finishBattle(USER, setup.battleId, played.decisions, nextDay);
  for (let attempt = 0; attempt < 12 && summary.result !== "won"; attempt++) {
    const next = await game.startBattle(USER, { deckId: deck.id, kind: "daily" }, DAY);
    summary = await game.finishBattle(USER, next.battleId, play(next).decisions, nextDay);
  }
  assert.equal(summary.result, "won", "the daily can be won well enough to test its payout");
  const claim = await db
    .prepare("SELECT claim_key FROM reward_claims WHERE user_id = ? AND claim_key LIKE ?")
    .bind(USER, "daily:%")
    .first() as { claim_key: string } | null;
  assert.equal(claim?.claim_key, "daily:" + kstDate(DAY), "the claim is for the issue day, not the settle day");
});

test('pending battles are bounded, so the table cannot grow without limit', async () => {
  reset();
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  const deck = (await game.createDeck(USER, '무한 덱', owned)).find((entry) => entry.name === '무한 덱')!;
  for (let index = 0; index < 60; index++) {
    await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, DAY);
  }
  const rows = await db.prepare("SELECT COUNT(*) AS c FROM battles WHERE user_id = ? AND result = 'pending'").bind(USER).first() as { c: number };
  assert.equal(Number(rows.c) <= 40, true, 'the oldest pending drafts are pruned');
  const newest = await db.prepare("SELECT COUNT(*) AS c FROM battles WHERE user_id = ?").bind(USER).first() as { c: number };
  assert.equal(Number(newest.c) <= 40, true);
});

test('an unverifiable log leaves the battle pending instead of freezing it', async () => {
  reset();
  seedOwned(db, USER, cardIdsByRarity({ N: 3 }));
  const owned = cardIdsByRarity({ N: 3 });
  const deck = (await game.createDeck(USER, '재시도 덱', owned)).find((entry) => entry.name === '재시도 덱')!;
  const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, DAY);
  // A client that lost its action log submits nothing: no reward, but not a bricked battle.
  const broken = await game.finishBattle(USER, setup.battleId, [], DAY);
  assert.equal(broken.result, 'invalid');
  assert.deepEqual(broken.rewards, []);
  const stillPending = await db.prepare('SELECT result FROM battles WHERE id = ?').bind(setup.battleId).first() as { result: string };
  assert.equal(stillPending.result, 'pending', 'the battle is still settleable with a real log');
  const retry = await game.finishBattle(USER, setup.battleId, play(setup).decisions, DAY);
  assert.notEqual(retry.result, 'invalid', 'the same battle settles once a legal log arrives');
});

/** Plays a started battle with the shared engine, preferring skills and falling back to attacks. */
function play(setup: Awaited<ReturnType<typeof game.startBattle>>) {
  const full = buildSetup({
    kind: setup.kind,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    playerCardIds: setup.player.map((entry) => entry.cardId),
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
    if (result.error || !result.state) break;
    state = result.state;
    if (isPlayer) decisions.push({ uid, action });
  }
  return { decisions, result: state.status };
}
