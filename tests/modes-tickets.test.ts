// Backend coverage for the difficulty modes, mode unlocks, guaranteed-pull tickets, coupons,
// 10-pulls, and the deterministic ticket drop. Runs against the shipped migrations.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const USER = 'mode_user';
const db = createD1();
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;

const game = await import('../lib/game.ts');
const { OPPONENTS, MODE_LABELS, opponentById } = await import('../lib/battle/opponents.ts');
const { pveFirstClearClaimKey, rollTicketDrop, ticketDropClaimKey } = await import('../lib/rewards.ts');
const { buildSetup } = await import('../lib/battle/setup.ts');
const { advance, createBattle } = await import('../lib/battle/engine.ts');
const { aiDecision } = await import('../lib/battle/ai.ts');
const { cardIdsByRarity, seedOwned } = await import('./helpers/seed.ts');

const DAY = new Date('2026-09-10T03:00:00Z');

function reset() {
  for (const table of ['reward_claims', 'user_achievements', 'battles', 'deck_cards', 'decks', 'inventory', 'pull_history', 'coupon_redemptions', 'user_game_state', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('${USER}', 'm@local.invalid', 'now', 'now')`);
  db.exec(`INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, pity_counter, sr_tickets, ssr_tickets) VALUES ('${USER}', 0, NULL, 0, 0, 0)`);
}

function grantFirstClears(mode: 'normal' | 'hard') {
  for (const opponent of OPPONENTS) {
    db.exec(
      `INSERT INTO reward_claims (user_id, claim_key, credits, claimed_at) VALUES ('${USER}', '${pveFirstClearClaimKey(opponent.id, mode)}', 0, 'now')`
    );
  }
}

async function makeDeck(name: string) {
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  return (await game.createDeck(USER, name, owned)).find((entry) => entry.name === name)!;
}

test('difficulty modes unlock server-side: 5 normal opens hard, 5 hard opens chaos', async () => {
  reset();
  const deck = await makeDeck('모드 덱');

  await assert.rejects(game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie', mode: 'hard' }, DAY), /잠겨/);
  const locked = await game.getSnapshot(USER, DAY);
  assert.deepEqual(locked.unlockedModes, ['normal']);
  assert.deepEqual(locked.clearedByMode, { normal: [], hard: [], chaos: [] });

  grantFirstClears('normal');
  const hardOpen = await game.getSnapshot(USER, DAY);
  assert.deepEqual(hardOpen.unlockedModes, ['normal', 'hard']);
  assert.deepEqual(hardOpen.clearedByMode.normal, OPPONENTS.map((opponent) => opponent.id));

  const hard = await game.startBattle(USER, { deckId: deck.id, opponentId: 'regular', mode: 'hard' }, DAY);
  assert.equal(hard.mode, 'hard');
  assert.equal(hard.opponent.length, 3);
  await assert.rejects(game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie', mode: 'chaos' }, DAY), /잠겨/);

  grantFirstClears('hard');
  assert.deepEqual((await game.getSnapshot(USER, DAY)).unlockedModes, ['normal', 'hard', 'chaos']);
  const chaos = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie', mode: 'chaos' }, DAY);
  assert.equal(chaos.mode, 'chaos');
  assert.equal(chaos.opponent.map((entry) => entry.maxHp).every((hp) => hp > 0), true);

  // A stored battle replays under the mode it was started with, never the client's current pick.
  const replay = await game.replayBattle(USER, hard.battleId);
  assert.equal(replay.mode, 'hard');
  assert.equal(replay.setup.mode, 'hard');
});

test('mode difficulty scales HP/ATK/DEF and first-clear credits (1x/2x/4x)', () => {
  const base = opponentById('boss');
  const hard = opponentById('boss', 'hard');
  const chaos = opponentById('boss', 'chaos');
  assert.ok(base);
  assert.equal(base.statScale, 1.06, 'normal raises base stats');
  assert.equal(hard!.statScale, 1.5, 'hard raises stats');
  assert.equal(chaos!.statScale, 2.1, 'chaos raises stats');
  assert.equal(hard!.reward.credits, base!.reward.credits * 2);
  assert.equal(chaos!.reward.credits, base!.reward.credits * 4);
  assert.ok(hard!.hpScale > base!.hpScale && chaos!.hpScale > hard!.hpScale);
  assert.ok(hard!.profile.skillAppetite >= base!.profile.skillAppetite);
  assert.equal(opponentById('nope', 'hard'), undefined);
  assert.equal(MODE_LABELS.hard, '하드');
  assert.notEqual(pveFirstClearClaimKey('rookie', 'hard'), pveFirstClearClaimKey('rookie', 'normal'));
});

test('guaranteed ticket pulls floor the rarity, spend only their balance, and never touch pity', async () => {
  reset();
  await db.prepare('UPDATE user_game_state SET sr_tickets = 3, ssr_tickets = 2, pity_counter = 12 WHERE user_id = ?').bind(USER).run();

  const sr = await game.pullCards(USER, 1, 'sr');
  assert.ok(['SR', 'SSR', 'UR'].includes(sr.results[0]!.card.rarity));
  assert.equal(sr.snapshot.tickets.sr, 2);
  assert.equal(sr.snapshot.tickets.ssr, 2);
  assert.equal(await pityOf(), 12, 'a guaranteed pull does not dilute or reset normal pity');

  const ssr = await game.pullCards(USER, 1, 'ssr');
  assert.ok(['SSR', 'UR'].includes(ssr.results[0]!.card.rarity));
  assert.equal(ssr.snapshot.tickets.ssr, 1);
  assert.equal(await pityOf(), 12, 'SSR+ guarantees still leave the normal ladder alone');

  // Guaranteed multipulls are allowed and charge exactly their own balance.
  await db.prepare('UPDATE user_game_state SET sr_tickets = 10 WHERE user_id = ?').bind(USER).run();
  const ten = await game.pullCards(USER, 10, 'sr');
  assert.equal(ten.results.length, 10);
  assert.equal(ten.results.every((entry) => ['SR', 'SSR', 'UR'].includes(entry.card.rarity)), true);
  assert.equal(ten.snapshot.tickets.sr, 0);
  assert.equal(await pityOf(), 12, 'a 10-ticket pull is still pity-neutral');
});

test('an unaffordable ticket pull rolls back cleanly and a 10-pull charges ten credits', async () => {
  reset();
  const before = countOf('inventory');
  await assert.rejects(game.pullCards(USER, 1, 'sr'), /뽑기권/);
  assert.equal(await ticketOf('sr_tickets'), 0, 'no ticket was spent');
  assert.equal(countOf('inventory'), before, 'nothing was granted');
  assert.equal(countOf('pull_history'), 0, 'no pull was recorded');

  await db.prepare('UPDATE user_game_state SET pull_credits = 10, last_free_pull_date = NULL WHERE user_id = ?').bind(USER).run();
  const ten = await game.pullCards(USER, 10);
  assert.equal(ten.results.length, 10);
  assert.equal(ten.results.some((entry) => entry.usedFreePull), false, 'the daily free pull never covers a multipull');
  assert.equal(await creditsOf(), 0);
});

test('100p coupon codes grant 20 guaranteed tickets, once, case-insensitively', async () => {
  reset();
  const sr = await game.redeemCoupon(USER, ' limketmon_sr_100p ');
  assert.deepEqual(sr.granted, { credits: 0, sr: 20, ssr: 0 });
  assert.equal(sr.snapshot.tickets.sr, 20);
  await assert.rejects(game.redeemCoupon(USER, 'LIMKETMON_SR_100P'), /이미 사용한 쿠폰/);

  const ssr = await game.redeemCoupon(USER, 'limketmon_ssr_100p');
  assert.deepEqual(ssr.granted, { credits: 0, sr: 0, ssr: 20 });
  assert.equal(ssr.snapshot.tickets.ssr, 20);

  const credits = await game.redeemCoupon(USER, 'LIMKETMON');
  assert.deepEqual(credits.granted, { credits: 100, sr: 0, ssr: 0 });
  await assert.rejects(game.redeemCoupon(USER, 'nope'), /유효하지 않은/);
});

test('the ticket drop odds are exclusive cumulative ranges for every mode', () => {
  // rollTicketDrop takes the settlement's uniform private draw in [0, 1); each mode owns a
  // half-open SR band, then a half-open SSR band, then no drop.
  const cases: Array<[('normal' | 'hard' | 'chaos'), number, 'sr' | 'ssr' | null]> = [
    ['normal', 0, 'sr'],
    ['normal', 0.099999, 'sr'],
    ['normal', 0.1, 'ssr'],
    ['normal', 0.119999, 'ssr'],
    ['normal', 0.12, null],
    ['normal', 0.999999, null],
    ['hard', 0, 'sr'],
    ['hard', 0.199999, 'sr'],
    ['hard', 0.2, 'ssr'],
    ['hard', 0.249999, 'ssr'],
    ['hard', 0.25, null],
    ['hard', 0.999999, null],
    ['chaos', 0, 'sr'],
    ['chaos', 0.299999, 'sr'],
    ['chaos', 0.3, 'ssr'],
    ['chaos', 0.399999, 'ssr'],
    ['chaos', 0.4, null],
    ['chaos', 0.999999, null]
  ];
  for (const [mode, unit, expected] of cases) {
    assert.equal(rollTicketDrop(mode, unit), expected, `${mode} draw ${unit} should be ${expected}`);
  }
});

test('the ticket drop is a private settlement draw, persisted once and never paid twice', async () => {
  reset();
  const deck = await makeStrongDeck('드랍 덱');

  // Force the settlement's private draw to a normal-mode SR roll (unit < 0.1). The battle seed
  // itself is still a real crypto draw, so public-seed unpredictability is untouched.
  const srWin = await winWithDrop(deck.id, 'rookie', 0.05);
  const srLines = srWin.summary.rewards.filter((line) => line.ticketType);
  assert.equal(srLines.length, 1, 'a forced SR drop appears once in the settled summary');
  assert.equal(srLines[0]!.ticketType, 'sr');
  assert.equal(srLines[0]!.credits, 0, 'a ticket line never pays credits');
  assert.equal(srLines[0]!.quantity, 1);

  // The persisted claim, the returned reward line, and the ticket balance all agree.
  const srClaim = await claimOf(srWin.battleId);
  assert.equal(srClaim?.ticket_type, 'sr');
  assert.equal(Number(srClaim?.ticket_quantity), 1);
  assert.equal(Number(srClaim?.credits), 0);
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { sr: 1, ssr: 0 });
  assert.equal(await ticketOf('sr_tickets'), 1);
  assert.equal(await ticketOf('ssr_tickets'), 0);
  // The credit balance equals the credits actually listed in the returned receipt.
  assert.equal(await creditsOf(), srWin.summary.rewards.reduce((sum, line) => sum + line.credits, 0));

  // A second win forced to an SSR roll adds exactly one SSR ticket alongside the SR one.
  const ssrWin = await winWithDrop(deck.id, 'rookie', 0.11);
  const ssrLines = ssrWin.summary.rewards.filter((line) => line.ticketType);
  assert.equal(ssrLines.length, 1);
  assert.equal(ssrLines[0]!.ticketType, 'ssr');
  assert.equal((await claimOf(ssrWin.battleId))?.ticket_type, 'ssr');
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { sr: 1, ssr: 1 });

  // Re-settling the same battle returns the identical receipt even when the private draw is forced
  // to a different band, and never mints a second ticket.
  const again = await withRandomUnit(0.999, () => game.finishBattle(USER, srWin.battleId, srWin.decisions, DAY));
  assert.deepEqual(again, srWin.summary);
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { sr: 1, ssr: 1 });
});

test('concurrent distinct battles competing for same daily/first-clear pay exactly one winner', async () => {
  reset();
  const owned = cardIdsByRarity({ R: 3 });
  seedOwned(db, USER, owned);
  for (const cardId of owned) {
    db.prepare('UPDATE inventory SET enhance_level = 10 WHERE user_id = ? AND card_id = ?').bind(USER, cardId).run();
  }
  const [deck] = await game.createDeck(USER, '경쟁 덱', owned);
  const b1 = await game.startBattle(USER, { deckId: deck.id, kind: 'daily' }, DAY);
  const b2 = await game.startBattle(USER, { deckId: deck.id, kind: 'daily' }, DAY);
  assert.notEqual(b1.battleId, b2.battleId);

  const p1 = play(b1);
  const p2 = play(b2);
  assert.equal(p1.result, 'won');
  assert.equal(p2.result, 'won');
  // Settle both battles simultaneously competing for the exact same daily claim key
  const [s1, s2] = await Promise.all([
    game.finishBattle(USER, b1.battleId, p1.decisions, DAY),
    game.finishBattle(USER, b2.battleId, p2.decisions, DAY)
  ]);

  const s1HasDaily = s1.rewards.some((r) => r.label === '데일리 챌린지 보상');
  const s2HasDaily = s2.rewards.some((r) => r.label === '데일리 챌린지 보상');
  // Exactly one battle must get the daily payout line
  assert.equal(Number(s1HasDaily) + Number(s2HasDaily), 1, 'exactly one battle gets the daily reward line');

  // Daily ticket drop can only be minted by the battle that won the daily claim
  const s1Tickets = s1.rewards.filter((r) => r.ticketType).reduce((sum, r) => sum + (r.quantity ?? 0), 0);
  const s2Tickets = s2.rewards.filter((r) => r.ticketType).reduce((sum, r) => sum + (r.quantity ?? 0), 0);
  if (!s1HasDaily) assert.equal(s1Tickets, 0, 'loser of daily claim cannot mint ticket');
  if (!s2HasDaily) assert.equal(s2Tickets, 0, 'loser of daily claim cannot mint ticket');

  // Verify total credits in user_game_state equals the sum of credits actually in summary.rewards across both finishes
  const credits = await creditsOf();
  const totalRewardsCredits = s1.rewards.reduce((s, r) => s + r.credits, 0) + s2.rewards.reduce((s, r) => s + r.credits, 0);
  assert.equal(credits, totalRewardsCredits, 'credits match sum of actually paid rewards');
});

test('P0 regression: insufficient balance or missing state cannot grant cards or pull history', async () => {
  reset();
  const card = { id: 'imsingyu-v001', rarity: 'SR' } as Parameters<typeof game.pullCards>[0] extends string ? any : never;
  // Test 1: Direct savePull with missing user_game_state row cannot grant cards or history
  const { savePull } = await import('../lib/pull.ts');
  await db.prepare('DELETE FROM user_game_state WHERE user_id = ?').bind(USER).run();
  await assert.rejects(savePull(db, USER, [card], new Date(), 0, 1, 'normal'), /pity_changed/);
  assert.equal(countOf('inventory'), 0, 'no card granted for missing state');
  assert.equal(countOf('pull_history'), 0, 'no history written for missing state');

  await assert.rejects(savePull(db, USER, [card], new Date(), 0, 1, 'sr'), /not_enough_tickets/);
  assert.equal(countOf('inventory'), 0, 'no card granted for missing state ticket pull');
  assert.equal(countOf('pull_history'), 0, 'no history written for missing state ticket pull');

  // Test 2: Concurrent two 10-pulls with balance of 10 tickets grant only 10 cards
  await db.prepare('INSERT INTO user_game_state (user_id, pull_credits, sr_tickets, ssr_tickets) VALUES (?, 100, 10, 0)').bind(USER).run();
  const tenCards = Array(10).fill(card);
  const [pull1, pull2] = await Promise.allSettled([
    savePull(db, USER, tenCards, new Date(), 0, 0, 'sr'),
    savePull(db, USER, tenCards, new Date(), 0, 0, 'sr')
  ]);
  const successCount = [pull1, pull2].filter((p) => p.status === 'fulfilled').length;
  const failCount = [pull1, pull2].filter((p) => p.status === 'rejected').length;
  assert.equal(successCount, 1, 'one 10-pull succeeds');
  assert.equal(failCount, 1, 'one 10-pull fails');
  assert.equal(countOf('pull_history'), 10, 'exactly 10 history rows written');
  assert.equal((await ticketOf('sr_tickets')), 0, 'tickets zeroed out');
  assert.equal((await creditsOf()), 100, 'normal credits untouched by ticket pull');
});

test('a settled battle is re-read from its real receipts, never a provisional summary', async () => {
  reset();
  const deck = await makeDeck('영수증 덱');
  const win = await winOnce(deck.id, 'rookie');
  assert.ok(win.summary.rewards.length > 0, 'the first clear paid at least one reward line');
  const creditsAfterWin = await creditsOf();

  // The crash window: the settlement batch committed (row settled, claims written) but the
  // post-commit authoritative summary write never ran, so the row still holds the provisional
  // empty-rewards summary.
  db.prepare('UPDATE battles SET summary = ? WHERE id = ? AND user_id = ?')
    .bind(
      JSON.stringify({
        result: win.summary.result,
        rewards: [],
        unlocked: [],
        mvpCardId: win.summary.mvpCardId,
        rounds: win.summary.rounds,
        damageDealt: win.summary.damageDealt
      }),
      win.battleId,
      USER
    )
    .run();

  const retry = await game.finishBattle(USER, win.battleId, win.decisions, DAY);
  assert.deepEqual(retry.rewards, win.summary.rewards, 'the retry reports the receipts that were really paid');
  assert.deepEqual(retry.unlocked, win.summary.unlocked, 'achievements come from the claim rows');
  assert.equal(await creditsOf(), creditsAfterWin, 'a retry never pays a second time');
  const twice = await game.finishBattle(USER, win.battleId, win.decisions, DAY);
  assert.deepEqual(twice.rewards, win.summary.rewards);
  assert.equal(await creditsOf(), creditsAfterWin);
});

test('progress reads stay bounded to known keys, indexed, and correct after many battles', async () => {
  reset();
  const deck = await makeDeck('대량 덱');
  await winOnce(deck.id, 'rookie');
  // Every repeat battle also leaves its own settle:<id> and ticket_drop:<id> rows behind.
  for (let index = 0; index < 400; index++) {
    db.exec(`INSERT INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES ('${USER}', 'settle:noise-${index}', 0, 'noise-${index}', 'now')`);
    db.exec(`INSERT INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES ('${USER}', 'ticket_drop:noise-${index}', 0, 'noise-${index}', 'now')`);
  }

  const seen: Array<{ query: string; bindings: unknown[] }> = [];
  const original = db.prepare.bind(db);
  db.prepare = (query: string) => {
    const statement = original(query);
    const bind = statement.bind.bind(statement);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        if (query.includes('FROM reward_claims') && query.includes('claim_key IN')) seen.push({ query, bindings: args });
        return bind(...args);
      }
    };
  };
  let snapshot;
  try {
    snapshot = await game.getSnapshot(USER, DAY);
  } finally {
    db.prepare = original;
  }

  assert.ok(seen.length > 0, 'the snapshot reads claims through the bounded IN query');
  for (const call of seen) assert.ok(call.bindings.length <= 25, `bounded to ${call.bindings.length} bindings`);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]!.query}`).all(...seen[0]!.bindings) as { results: Array<{ detail: string }> };
  const detail = plan.results.map((row) => row.detail).join(' | ');
  assert.match(detail, /SEARCH reward_claims USING (COVERING )?INDEX sqlite_autoindex_reward_claims_1/);
  assert.ok(!/SCAN/.test(detail), detail);

  // The bounded read is still functionally complete: the 15 first-clear keys keep unlocking modes.
  assert.deepEqual(snapshot.unlockedModes, ['normal']);
  assert.deepEqual(snapshot.clearedByMode.normal, ['rookie']);
  // 'rookie' is already claimed by the win above, so only the missing first clears are inserted.
  for (const opponent of OPPONENTS) {
    db.exec(`INSERT OR IGNORE INTO reward_claims (user_id, claim_key, credits, claimed_at) VALUES ('${USER}', '${pveFirstClearClaimKey(opponent.id, 'normal')}', 0, 'now')`);
  }
  const opened = await game.getSnapshot(USER, DAY);
  assert.deepEqual(opened.unlockedModes, ['normal', 'hard']);
  assert.deepEqual(opened.clearedByMode.normal, OPPONENTS.map((opponent) => opponent.id));
});

test('a loss never drops a ticket', async () => {
  reset();
  const deck = await makeDeck('패배 덱');
  for (let attempt = 0; attempt < 20; attempt++) {
    const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'boss' }, DAY);
    const played = play(setup);
    const summary = await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
    if (summary.result === 'won') continue;
    assert.equal(summary.rewards.some((line) => line.ticketType), false, 'a non-win pays no ticket');
    assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { sr: 0, ssr: 0 });
    return;
  }
  throw new Error('an N deck never lost to the boss in 20 attempts');
});

async function creditsOf(): Promise<number> {
  const row = (await db.prepare('SELECT pull_credits FROM user_game_state WHERE user_id = ?').bind(USER).first()) as { pull_credits: number };
  return Number(row.pull_credits);
}

async function pityOf(): Promise<number> {
  const row = (await db.prepare('SELECT pity_counter FROM user_game_state WHERE user_id = ?').bind(USER).first()) as { pity_counter: number };
  return Number(row.pity_counter);
}

async function ticketOf(column: 'sr_tickets' | 'ssr_tickets'): Promise<number> {
  const row = (await db.prepare(`SELECT ${column} AS value FROM user_game_state WHERE user_id = ?`).bind(USER).first()) as { value: number };
  return Number(row.value);
}

function countOf(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

function play(setup: Awaited<ReturnType<typeof game.startBattle>>) {
  const full = buildSetup({
    kind: setup.kind,
    mode: setup.mode,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    playerCardIds: setup.player.map((entry) => entry.cardId),
    playerEnhance: setup.player.map((entry: { enhance?: number }) => entry.enhance ?? 0),
    battleId: setup.battleId
  });
  const profile = opponentById(setup.opponentId, setup.mode)!.profile;
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
    if (result.error) throw new Error(`engine error: ${result.error}`);
    state = result.state;
    if (isPlayer) decisions.push({ uid, action });
  }
  return { decisions, result: state.status };
}

async function winOnce(deckId: string, opponentId: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const setup = await game.startBattle(USER, { deckId, opponentId }, DAY);
    const played = play(setup);
    const summary = await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
    if (summary.result === 'won') return { battleId: setup.battleId, seed: setup.seed, decisions: played.decisions, summary };
  }
  throw new Error(`no win against ${opponentId} in 12 attempts`);
}

/**
 * A deck that reliably beats the weakest opponent, so ticket-drop assertions never flake on a
 * random loss. Three Rare cards at max enhance end every fight in a win regardless of the seed.
 */
async function makeStrongDeck(name: string) {
  const owned = cardIdsByRarity({ R: 3 });
  seedOwned(db, USER, owned);
  for (const cardId of owned) {
    db.prepare('UPDATE inventory SET enhance_level = 10 WHERE user_id = ? AND card_id = ?').bind(USER, cardId).run();
  }
  return (await game.createDeck(USER, name, owned)).find((entry) => entry.name === name)!;
}

async function claimOf(battleId: string) {
  return (await db
    .prepare('SELECT ticket_type, ticket_quantity, credits FROM reward_claims WHERE user_id = ? AND claim_key = ?')
    .bind(USER, ticketDropClaimKey(battleId))
    .first()) as { ticket_type: string | null; ticket_quantity: number; credits: number } | null;
}

/**
 * Runs settle-time work with the server's private crypto draw pinned to one uniform value, so the
 * ticket drop is exercised deterministically. Only randomUnit() reads crypto.getRandomValues during
 * settlement; the battle seed is drawn earlier, outside this window. Restored unconditionally.
 */
async function withRandomUnit<T>(unit: number, run: () => Promise<T>): Promise<T> {
  const webcrypto = globalThis.crypto;
  const original = webcrypto.getRandomValues;
  webcrypto.getRandomValues = ((array: Uint32Array) => {
    array[0] = Math.floor(unit * 2 ** 32);
    return array;
  }) as typeof webcrypto.getRandomValues;
  try {
    return await run();
  } finally {
    webcrypto.getRandomValues = original;
  }
}

async function winWithDrop(deckId: string, opponentId: string, unit: number) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const setup = await game.startBattle(USER, { deckId, opponentId }, DAY);
    const played = play(setup);
    const summary = await withRandomUnit(unit, () =>
      game.finishBattle(USER, setup.battleId, played.decisions, DAY)
    );
    if (summary.result === 'won') return { battleId: setup.battleId, seed: setup.seed, decisions: played.decisions, summary };
  }
  throw new Error(`no win against ${opponentId} with a forced drop in 12 attempts`);
}
