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
const { pveFirstClearClaimKey, ticketDropClaimKey, victoryTicketReward } = await import('../lib/rewards.ts');
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
  assert.deepEqual(locked.clearedByMode, { normal: [], hard: [], chaos: [], extreme: [] });

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
  assert.ok(Math.abs((base.statScale ?? 0) - 1.06 * 1.2) < 1e-9, 'normal boss is +20% on the 1.06 band');
  assert.ok(Math.abs((hard!.statScale ?? 0) - 1.62 * 0.92) < 1e-9, 'hard boss is pulled back');
  assert.ok(Math.abs((chaos!.statScale ?? 0) - 2.18 * 1.04) < 1e-9, 'chaos boss rises less than general stages');
  assert.equal(hard!.reward.credits, base!.reward.credits * 2);
  assert.equal(chaos!.reward.credits, base!.reward.credits * 4);
  assert.ok(hard!.hpScale > base!.hpScale && chaos!.hpScale > hard!.hpScale);
  assert.ok(hard!.profile.skillAppetite >= base!.profile.skillAppetite);
  assert.equal(opponentById('nope', 'hard'), undefined);
  assert.equal(MODE_LABELS.hard, '하드');
  assert.notEqual(pveFirstClearClaimKey('rookie', 'hard'), pveFirstClearClaimKey('rookie', 'normal'));
});

test('guaranteed ticket pulls floor the rarity and spend only their own balance', async () => {
  reset();
  await db.prepare('UPDATE user_game_state SET sr_tickets = 3, ssr_tickets = 2, pity_counter = 12 WHERE user_id = ?').bind(USER).run();

  const sr = await game.pullCards(USER, 1, 'sr');
  assert.ok(['SR', 'SSR', 'UR'].includes(sr.results[0]!.card.rarity));
  assert.equal(sr.snapshot.tickets.sr, 2);
  assert.equal(sr.snapshot.tickets.ssr, 2);

  const ssr = await game.pullCards(USER, 1, 'ssr');
  assert.ok(['SSR', 'UR'].includes(ssr.results[0]!.card.rarity));
  assert.equal(ssr.snapshot.tickets.ssr, 1);

  // Guaranteed multipulls are allowed and charge exactly their own balance.
  await db.prepare('UPDATE user_game_state SET sr_tickets = 10 WHERE user_id = ?').bind(USER).run();
  const ten = await game.pullCards(USER, 10, 'sr');
  assert.equal(ten.results.length, 10);
  assert.equal(ten.results.every((entry) => ['SR', 'SSR', 'UR'].includes(entry.card.rarity)), true);
  assert.equal(ten.snapshot.tickets.sr, 0);
  // The pity ladder is gone from the snapshot entirely.
  assert.equal('pityRemaining' in ten.snapshot, false);
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

test('coupon codes grant their fixed bundles, once, case-insensitively', async () => {
  reset();
  // LIMKETMON now grants an SSR+ single, ten normal pulls, and fifty low tickets.
  const welcome = await game.redeemCoupon(USER, ' limketmon ');
  assert.equal(welcome.snapshot.tickets.ssr, 1);
  assert.equal(welcome.snapshot.tickets.low, 50);
  assert.equal(welcome.snapshot.credits, 10);
  await assert.rejects(game.redeemCoupon(USER, 'LIMKETMON'), /이미 사용한 쿠폰/);

  const sr = await game.redeemCoupon(USER, ' limketmon_sr_100p ');
  assert.deepEqual(sr.granted, { credits: 0, low: 0, sr: 20, ssr: 0 });
  assert.equal(sr.snapshot.tickets.sr, 20);
  await assert.rejects(game.redeemCoupon(USER, 'LIMKETMON_SR_100P'), /이미 사용한 쿠폰/);

  const ssr = await game.redeemCoupon(USER, 'limketmon_ssr_100p');
  assert.deepEqual(ssr.granted, { credits: 0, low: 0, sr: 0, ssr: 20 });
  assert.equal(ssr.snapshot.tickets.ssr, 21);
  await assert.rejects(game.redeemCoupon(USER, 'nope'), /유효하지 않은/);

  const hannam = await game.redeemCoupon(USER, ' hannamspecial ');
  assert.deepEqual(hannam.granted, { credits: 20, low: 50, sr: 10, ssr: 0 });
  assert.equal(hannam.snapshot.credits, 30);
  assert.equal(hannam.snapshot.tickets.low, 100);
  assert.equal(hannam.snapshot.tickets.sr, 30);
  await assert.rejects(game.redeemCoupon(USER, 'HANNAMSPECIAL'), /이미 사용한 쿠폰/);
});

test('the win ticket is fixed per mode and opponent', () => {
  // Normal pays low tickets for the lower opponents and normal tickets for ace/boss.
  assert.deepEqual(victoryTicketReward('normal', 'rookie'), { ticketType: 'low', quantity: 1 });
  assert.deepEqual(victoryTicketReward('normal', 'regular'), { ticketType: 'low', quantity: 2 });
  assert.deepEqual(victoryTicketReward('normal', 'veteran'), { ticketType: 'low', quantity: 3 });
  assert.deepEqual(victoryTicketReward('normal', 'ace'), { ticketType: 'normal', quantity: 2 });
  assert.deepEqual(victoryTicketReward('normal', 'boss'), { ticketType: 'normal', quantity: 3 });
  // Hard pays normal tickets, and an SR+ pair for the boss.
  assert.deepEqual(victoryTicketReward('hard', 'rookie'), { ticketType: 'normal', quantity: 3 });
  assert.deepEqual(victoryTicketReward('hard', 'regular'), { ticketType: 'normal', quantity: 4 });
  assert.deepEqual(victoryTicketReward('hard', 'veteran'), { ticketType: 'normal', quantity: 5 });
  assert.deepEqual(victoryTicketReward('hard', 'ace'), { ticketType: 'normal', quantity: 6 });
  assert.deepEqual(victoryTicketReward('hard', 'boss'), { ticketType: 'sr', quantity: 2 });
  // Chaos pays SR+, with an SSR+ pair for ace/boss.
  assert.deepEqual(victoryTicketReward('chaos', 'rookie'), { ticketType: 'sr', quantity: 2 });
  assert.deepEqual(victoryTicketReward('chaos', 'regular'), { ticketType: 'sr', quantity: 3 });
  assert.deepEqual(victoryTicketReward('chaos', 'veteran'), { ticketType: 'sr', quantity: 4 });
  assert.deepEqual(victoryTicketReward('chaos', 'ace'), { ticketType: 'ssr', quantity: 1 });
  assert.deepEqual(victoryTicketReward('chaos', 'boss'), { ticketType: 'ssr', quantity: 2 });
  assert.deepEqual(victoryTicketReward('extreme', 'boss', 'ssr'), { ticketType: 'ssr', quantity: 2 });
  assert.deepEqual(victoryTicketReward('extreme', 'rookie', 'sr'), { ticketType: 'sr', quantity: 3 });
});

test('every win pays its ticket and the first clear pays it once more', async () => {
  reset();
  const deck = await makeStrongDeck('보상 덱');

  // Normal rookie: low x1 every win, plus low x1 extra on the first clear → two lines, 2 total.
  const win = await winOnce(deck.id, 'rookie');
  const lines = win.summary.rewards.filter((line) => line.ticketType === 'low');
  assert.equal(lines.reduce((sum, line) => sum + (line.quantity ?? 0), 0), 2, 'first rookie clear: 1 win + 1 first-clear extra');
  assert.equal(lines.every((line) => line.credits === 0), true, 'a ticket line never pays credits');
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { low: 2, sr: 0, ssr: 0 });

  // The per-battle win payout claim and the returned receipt agree.
  const claim = await claimOf(win.battleId);
  assert.equal(claim?.ticket_type, 'low');
  assert.equal(Number(claim?.ticket_quantity), 1);
  assert.equal(Number(claim?.credits), 0);

  // A repeat win pays only the win ticket.
  const repeat = await winOnce(deck.id, 'rookie');
  assert.equal(repeat.summary.rewards.filter((line) => line.label === '첫 격파 보상').length, 0);
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { low: 3, sr: 0, ssr: 0 });

  // Re-settling the first battle returns the identical receipt and mints nothing.
  const again = await game.finishBattle(USER, win.battleId, win.decisions, DAY);
  assert.deepEqual(again, win.summary);
  assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { low: 3, sr: 0, ssr: 0 });
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
  await assert.rejects(savePull(db, USER, [card], new Date(), 0, 1, 'normal'), /pull_state_missing/);
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
  const deck = await makeStrongDeck('영수증 덱');
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
  const deck = await makeStrongDeck('대량 덱');
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
  for (const call of seen) assert.ok(call.bindings.length <= 40, `bounded to ${call.bindings.length} bindings`);
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
    assert.deepEqual((await game.getSnapshot(USER, DAY)).tickets, { low: 0, sr: 0, ssr: 0 });
    return;
  }
  throw new Error('an N deck never lost to the boss in 20 attempts');
});

async function creditsOf(): Promise<number> {
  const row = (await db.prepare('SELECT pull_credits FROM user_game_state WHERE user_id = ?').bind(USER).first()) as { pull_credits: number };
  return Number(row.pull_credits);
}

async function ticketOf(column: 'sr_tickets' | 'ssr_tickets'): Promise<number> {
  const row = (await db.prepare(`SELECT ${column} AS value FROM user_game_state WHERE user_id = ?`).bind(USER).first()) as { value: number };
  return Number(row.value);
}

function countOf(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

function play(setup: Awaited<ReturnType<typeof game.startBattle>>) {
  const full = {
    battleId: setup.battleId,
    kind: setup.kind,
    mode: setup.mode,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    player: setup.player,
    opponent: setup.opponent
  };
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
  const setup = await game.startBattle(USER, { deckId, opponentId }, DAY);
  const played = play(setup);
  const summary = await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
  assert.equal(summary.result, 'won', 'controlled strong owned deck wins');
  return { battleId: setup.battleId, seed: setup.seed, decisions: played.decisions, summary };
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
