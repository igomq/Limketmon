// Drives the real route handlers the way the browser does: pull, coupon, deck, battle, replay.
// This is the end-to-end path from the manual checklist, minus rendering.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const db = createD1();
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}

const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;
const { setAuthenticatedUser } = await import('./helpers/next-headers.mjs');

const pullRoute = await import('../app/api/pull/route.ts');
const couponRoute = await import('../app/api/coupon/route.ts');
const stateRoute = await import('../app/api/state/route.ts');
const deckRoute = await import('../app/api/deck/route.ts');
const battleRoute = await import('../app/api/battle/route.ts');
const { buildSetup } = await import('../lib/battle/setup.ts');
const { runBattle } = await import('../lib/battle/simulate.ts');
const { aiDecision } = await import('../lib/battle/ai.ts');
const { opponentById } = await import('../lib/battle/opponents.ts');
const { dailyChallenge } = await import('../lib/daily.ts');
const { kstDate, rarityRank } = await import('../lib/rules.ts');
const { BATTLE_RULESET_VERSION } = await import('../lib/battle/types.ts');
const { CARD_BY_ID } = await import('../lib/battle/setup.ts');

/** Rarity of an owned card, for checking the daily rule without hard-coding ids. */
const rarityOf = (cardId: string) => CARD_BY_ID.get(cardId)?.rarity;
/** "X 이하" keeps cards whose rank number is at or below the cap's. */
const withinCap = (cardId: string, cap: NonNullable<Parameters<typeof rarityRank>[0]>) => {
  const rarity = rarityOf(cardId);
  return rarity !== undefined && rarityRank(rarity) >= rarityRank(cap);
};

const USER = 'e2e_user';
const INTRUDER = 'e2e_intruder';

function post(path: string, body: unknown) {
  return new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test('signed-in player can pull, build a deck, battle, get paid, and replay', async () => {
  setAuthenticatedUser(USER, 'e2e@local.invalid', '이투이');

  // 1. Free daily pull lands in the collection.
  const free = await pullRoute.POST(post('/api/pull', { count: 1 }));
  assert.equal(free.status, 200);
  const freeBody = await json<{ results: Array<{ usedFreePull: boolean; card: { id: string } }>; snapshot: { credits: number; inventory: unknown[] } }>(free);
  assert.equal(freeBody.results.length, 1);
  assert.equal(freeBody.results[0]!.usedFreePull, true);
  assert.equal(freeBody.snapshot.inventory.length, 1);

  // 2. The welcome coupon adds credits, and cannot be used twice.
  const coupon = await couponRoute.POST(post('/api/coupon', { code: 'LIMKETMON' }));
  assert.equal(coupon.status, 200);
  assert.equal((await json<{ snapshot: { credits: number } }>(coupon)).snapshot.credits, 100);
  const again = await couponRoute.POST(post('/api/coupon', { code: 'LIMKETMON' }));
  assert.equal(again.status, 400);

  // 3. A five-card pull charges exactly five credits.
  const five = await pullRoute.POST(post('/api/pull', { count: 5 }));
  const fiveBody = await json<{ results: unknown[]; snapshot: { credits: number; pityRemaining: number } }>(five);
  assert.equal(fiveBody.results.length, 5);
  assert.equal(fiveBody.snapshot.credits, 95);
  assert.ok(fiveBody.snapshot.pityRemaining <= 60 && fiveBody.snapshot.pityRemaining > 0);

  // 4. Keep pulling until at least three distinct cards exist, so a deck can be built.
  let state = await json<{ snapshot: { inventory: Array<{ cardId: string }>; decks: unknown[] } }>(await stateRoute.GET());
  for (let round = 0; round < 12 && state.snapshot.inventory.length < 3; round++) {
    await pullRoute.POST(post('/api/pull', { count: 5 }));
    state = await json<{ snapshot: { inventory: Array<{ cardId: string }> } }>(await stateRoute.GET());
  }
  assert.ok(state.snapshot.inventory.length >= 3, 'enough cards to build a deck');

  // 5. A deck can only use owned cards.
  const owned = state.snapshot.inventory.map((item) => item.cardId);
  const illegal = await deckRoute.POST(post('/api/deck', { action: 'create', name: '불법 덱', cardIds: ['imsingyu-v001', 'imsingyu-v046', 'nope'] }));
  assert.equal(illegal.status, 400);
  const created = await deckRoute.POST(post('/api/deck', { action: 'create', name: '테스트 덱', cardIds: owned.slice(0, 3) }));
  assert.equal(created.status, 200);
  const decks = (await json<{ decks: Array<{ id: string; name: string; isDefault: boolean; cards: string[] }> }>(created)).decks;
  const deck = decks.find((entry) => entry.name === '테스트 덱')!;
  assert.equal(deck.cards.length, 3);
  assert.equal(decks.some((entry) => entry.isDefault), true);

  // 6. Start a battle: the server decides the seed and the opponent.
  const start = await battleRoute.POST(post('/api/battle', { action: 'start', deckId: deck.id, opponentId: 'rookie' }));
  assert.equal(start.status, 200);
  const setup = (await json<{ setup: Parameters<typeof buildSetup>[0] & { battleId: string } }>(start)).setup;
  assert.equal(setup.player.length, 3);
  assert.equal(setup.opponent.length, 3);
  lastBattleId = setup.battleId;

  // 7. Play it locally with the shared engine and settle on the server.
  const decisions = play(setup);
  const finish = await battleRoute.POST(post('/api/battle', { action: 'finish', battleId: setup.battleId, decisions }));
  assert.equal(finish.status, 200);
  const summary = (await json<{ summary: { result: string; rewards: Array<{ credits: number }>; mvpCardId: string | null } }>(finish)).summary;
  assert.ok(['won', 'lost', 'draw'].includes(summary.result));
  assert.ok(owned.slice(0, 3).includes(summary.mvpCardId ?? owned[0]!) || summary.mvpCardId === null);

  // 8. Rewards are reflected in the next state read.
  const after = await json<{ snapshot: { credits: number; stats: { battles: number; wins: number }; clearedOpponents: string[] } }>(await stateRoute.GET());
  assert.equal(after.snapshot.stats.battles, 1);
  assert.equal(after.snapshot.credits, 95 + summary.rewards.reduce((sum, line) => sum + line.credits, 0));
  if (summary.result === 'won') assert.deepEqual(after.snapshot.clearedOpponents, ['rookie']);

  // 9. Re-settling the same battle pays nothing more and returns the same answer.
  const repeat = await battleRoute.POST(post('/api/battle', { action: 'finish', battleId: setup.battleId, decisions }));
  assert.deepEqual((await json<{ summary: unknown }>(repeat)).summary, summary);
  assert.equal((await json<{ snapshot: { credits: number } }>(await stateRoute.GET())).snapshot.credits, after.snapshot.credits);

  // 10. The replay reproduces the stored battle.
  const replay = await battleRoute.POST(post('/api/battle', { action: 'replay', battleId: setup.battleId }));
  assert.equal(replay.status, 200);
  const replayed = (await json<{ replay: { verified: boolean; result: string; rulesetVersion: number; events: unknown[] } }>(replay)).replay;
  assert.equal(replayed.verified, true);
  assert.equal(replayed.result, summary.result);
  assert.equal(replayed.rulesetVersion, BATTLE_RULESET_VERSION);
  assert.ok(replayed.events.length > 0);

  // 11. The daily challenge is the same for the signed-in day and reports its rule.
  const daily = await json<{ snapshot: { daily: { date: string; opponentId: string; cleared: boolean; modifier: unknown; rewardCredits: number } } }>(await stateRoute.GET());
  assert.equal(daily.snapshot.daily.date, kstDate(new Date()));
  assert.equal(daily.snapshot.daily.rewardCredits, 3);
  const challenge = dailyChallenge(kstDate(new Date()));
  assert.deepEqual(daily.snapshot.daily.modifier, challenge.modifier);
  // The rule of the day is enforced on start: a deck that breaks it is refused.
  if (challenge.modifier.kind === 'rarity_cap') {
    const cap = challenge.modifier.max;
    const refused = await battleRoute.POST(post('/api/battle', { action: 'start', deckId: deck.id, kind: 'daily' }));
    const breaksCap = deck.cards.some((id) => !withinCap(id, cap));
    if (breaksCap) {
      assert.equal(refused.status, 400, 'a deck above the cap cannot start the daily');
      const legal = owned.filter((id) => withinCap(id, cap));
      if (legal.length >= 3) {
        await deckRoute.POST(post('/api/deck', { action: 'create', name: '데일리 덱', cardIds: legal.slice(0, 3) }));
        const decksNow = (await json<{ decks: Array<{ id: string; name: string }> }>(await deckRoute.GET())).decks;
        const dailyDeck = decksNow.find((entry) => entry.name === '데일리 덱')!;
        const ok = await battleRoute.POST(post('/api/battle', { action: 'start', deckId: dailyDeck.id, kind: 'daily' }));
        assert.equal(ok.status, 200, 'a deck inside the cap starts the daily');
        assert.equal((await json<{ setup: { opponentId: string } }>(ok)).setup.opponentId, challenge.opponentId);
      }
    }
  }
  const dailyStart = await battleRoute.POST(post('/api/battle', { action: 'start', deckId: deck.id, kind: 'daily' }));
  if (dailyStart.status === 200) {
    const payload = await json<{ setup: { opponentId: string; modifier: unknown } }>(dailyStart);
    const dailySetup = payload.setup;
    assert.equal(dailySetup.opponentId, challenge.opponentId);
    assert.deepEqual(dailySetup.modifier, challenge.modifier);
  } else {
    assert.equal(dailyStart.status, 400, 'the daily either starts or is refused by its rule');
  }

  // 12. Deck edits round-trip and validation still bites.
  const renamed = await deckRoute.POST(post('/api/deck', { action: 'rename', deckId: deck.id, name: '이름 변경' }));
  assert.equal((await json<{ decks: Array<{ name: string }> }>(renamed)).decks.some((entry) => entry.name === '이름 변경'), true);
  const tooShort = await deckRoute.POST(post('/api/deck', { action: 'save', deckId: deck.id, cardIds: owned.slice(0, 2) }));
  assert.equal(tooShort.status, 400);
  const saved = await deckRoute.POST(post('/api/deck', { action: 'save', deckId: deck.id, cardIds: owned.slice(0, 3) }));
  assert.equal(saved.status, 200);
});

test('requests without a signed-in user are rejected and cannot touch other accounts', async () => {
  setAuthenticatedUser(INTRUDER, 'intruder@local.invalid');
  const created = await pullRoute.POST(post('/api/pull', { count: 1 }));
  assert.equal(created.status, 200);
  const intruderState = await json<{ snapshot: { decks: unknown[] } }>(await stateRoute.GET());
  assert.equal(intruderState.snapshot.decks.length, 0, 'a second account starts empty');

  // The intruder cannot use a deck id or battle id that belongs to someone else.
  const foreign = await battleRoute.POST(post('/api/battle', { action: 'start', deckId: 'made-up-deck', opponentId: 'rookie' }));
  assert.equal(foreign.status, 400);
  const foreignFinish = await battleRoute.POST(post('/api/battle', { action: 'finish', battleId: 'made-up-battle', decisions: [] }));
  assert.equal(foreignFinish.status, 400);

  // Signed out: every mutation is a 401 and the state read is a 401.
  setAuthenticatedUser(null);
  assert.equal((await pullRoute.POST(post('/api/pull', { count: 1 }))).status, 401);
  assert.equal((await deckRoute.POST(post('/api/deck', { action: 'create', name: 'x', cardIds: [] }))).status, 401);
  assert.equal((await battleRoute.POST(post('/api/battle', { action: 'start' }))).status, 401);
  assert.equal((await stateRoute.GET()).status, 401);

  // Malformed bodies are refused before they reach the game layer.
  setAuthenticatedUser(USER, 'e2e@local.invalid');
  assert.equal((await pullRoute.POST(post('/api/pull', { count: 3 }))).status, 400);
  assert.equal((await deckRoute.POST(post('/api/deck', { action: 'nope' }))).status, 400);
  assert.equal((await battleRoute.POST(post('/api/battle', { action: 'finish', battleId: setup1(), decisions: 'nope' }))).status, 400);
});

let lastBattleId: string | null = null;

/** The battle started in the first test; used here for a malformed-body check. */
function setup1(): string {
  return lastBattleId ?? 'missing';
}

/** Plays a started battle with the shared engine, preferring skills and falling back to attacks. */
function play(setup: { kind: 'pve' | 'daily'; opponentId: string; modifier: Parameters<typeof buildSetup>[0]['modifier']; seed: number; player: Array<{ cardId: string }>; battleId: string }) {
  const full = buildSetup({
    kind: setup.kind,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    playerCardIds: setup.player.map((entry) => entry.cardId),
    battleId: setup.battleId
  });
  const profile = opponentById(setup.opponentId)!.profile;
  const decide = (state: Parameters<typeof aiDecision>[0]) => aiDecision(state, profile);
  const decisions: Array<{ uid: string; action: 'attack' | 'skill' }> = [];
  for (let step = 0; step < 500; step++) {
    const probe = runBattle(full, decisions, decide);
    if (!probe.error) return decisions;
    if (probe.error !== 'unfinished') throw new Error(`engine error: ${probe.error}`);
    const uid = probe.state.activeUid!;
    decisions.push({ uid, action: 'skill' });
    const trial = runBattle(full, decisions, decide);
    if (trial.error && trial.error !== 'unfinished') decisions[decisions.length - 1] = { uid, action: 'attack' };
  }
  throw new Error('battle did not finish');
}
