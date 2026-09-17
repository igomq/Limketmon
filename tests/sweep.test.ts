import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const db = createD1();
const migrations = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrations), 'utf8'));
}
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;
const game = await import('../lib/game.ts');
const { pveFirstClearClaimKey, victoryTicketReward } = await import('../lib/rewards.ts');
const { setAuthenticatedUser } = await import('./helpers/next-headers.mjs');
const route = await import('../app/api/battle/route.ts');
const USER = 'sweep-user';

async function reset() {
  db.exec('DELETE FROM users');
  await game.ensureUser(USER, 'sweep@local.invalid');
  db.exec("UPDATE user_game_state SET proof = 300, fragments = 20, low_tickets = 0");
}
function clear(mode = 'normal', opponent = 'rookie', user = USER) {
  db.prepare('INSERT INTO reward_claims (user_id, claim_key, credits, claimed_at) VALUES (?, ?, 0, ?)')
    .bind(user, pveFirstClearClaimKey(opponent, mode), 'now').run();
}
function request(overrides = {}) {
  return { mode: 'normal', opponentId: 'rookie', count: 1, requestId: crypto.randomUUID(), ...overrides };
}
function wallet() {
  return { ...db.prepare('SELECT proof, fragments, pull_credits, low_tickets, sr_tickets, ssr_tickets FROM user_game_state WHERE user_id = ?').bind(USER).first() };
}

test('new accounts get three low tickets once, keeping the daily free card', async () => {
  db.exec('DELETE FROM users');
  await Promise.all([game.ensureUser(USER, 'a@local.invalid'), game.ensureUser(USER, 'a@local.invalid')]);
  const snapshot = await game.getSnapshot(USER);
  assert.equal(snapshot.tickets.low, 3);
  assert.equal(snapshot.freeAvailable, true);
  await game.pullCards(USER, 1, 'low');
  await game.ensureUser(USER, 'a@local.invalid');
  assert.equal(wallet().low_tickets, 2);
});

test('sweep rejects uncleared stages, another mode/account, invalid inputs and daily requests without writes', async () => {
  await reset();
  const before = wallet();
  await assert.rejects(game.sweepBattle(USER, request()), /먼저 격파/);
  clear();
  for (const overrides of [{ mode: 'hard' }, { opponentId: 'boss' }, { mode: 'unknown' }, { opponentId: 'toString' },
    ...[0, -1, 1.5, 101, '5', null, NaN, Infinity].map((count) => ({ count })),
    { material: 'fragments' }, { requestId: '' }]) {
    await assert.rejects(game.sweepBattle(USER, request(overrides)));
  }
  await game.ensureUser('other', 'other@local.invalid');
  await assert.rejects(game.sweepBattle('other', request()), /먼저 격파/);
  setAuthenticatedUser(USER, 'sweep@local.invalid', '테스트');
  const response = await route.POST(new Request('http://local/api/battle', { method: 'POST', body: JSON.stringify({ action: 'sweep', kind: 'daily', ...request() }) }));
  assert.equal(response.status, 400);
  assert.deepEqual(wallet(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reward_claims WHERE claim_key LIKE 'sweep:%'").first().n, 0);
});

test('every mode charges the exact cost and pays only repeated tickets, including both Extreme currencies', async () => {
  for (const [mode, material, unitCost] of [['normal', 'proof', 1], ['hard', 'proof', 4], ['chaos', 'proof', 10], ['extreme', 'fragments', 2], ['extreme', 'proof', 30]] as const) {
    await reset();
    clear(mode);
    const before = wallet();
    const reward = victoryTicketReward(mode, 'rookie', 'ssr');
    const result = await game.sweepBattle(USER, request({ mode, material, count: 5, rewardTicketType: 'ssr' }));
    assert.deepEqual(result, { count: 5, cost: unitCost * 5, ticketType: reward.ticketType, quantity: reward.quantity * 5 });
    const after = wallet();
    assert.equal(after[material], before[material] - unitCost * 5);
    assert.equal(after[material === 'proof' ? 'fragments' : 'proof'], before[material === 'proof' ? 'fragments' : 'proof']);
    const column = { low: 'low_tickets', normal: 'pull_credits', sr: 'sr_tickets', ssr: 'ssr_tickets' }[reward.ticketType];
    assert.equal(after[column], before[column] + reward.quantity * 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM battles').first().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_achievements').first().n, 0);
    const snapshot = await game.getSnapshot(USER);
    assert.equal(snapshot.stats.wins, 0);
    assert.deepEqual(snapshot.clearedByMode[mode], ['rookie']);
  }
  await assert.rejects(game.sweepBattle(USER, request({ mode: 'extreme' })), /보상을 선택/);
  await assert.rejects(game.sweepBattle(USER, request({ mode: 'extreme', rewardTicketType: { toString: null } })), /보상을 선택/);
});

test('simultaneous requests cannot overdraw, retries pay once and changed request IDs cannot reuse receipts', async () => {
  await reset();
  clear();
  db.exec('UPDATE user_game_state SET proof = 3');
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => game.sweepBattle(USER, request())));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(wallet().proof, 0);
  assert.equal(wallet().low_tickets, 3);

  db.exec('UPDATE user_game_state SET proof = 10, low_tickets = 0');
  const same = request({ count: 5 });
  const [left, right] = await Promise.all([game.sweepBattle(USER, same), game.sweepBattle(USER, same)]);
  assert.deepEqual(left, right);
  assert.equal(wallet().proof, 5);
  assert.equal(wallet().low_tickets, 5);
  await assert.rejects(game.sweepBattle(USER, { ...same, count: 6 }), /이미 처리/);
  assert.equal(wallet().proof, 5);

  db.exec('UPDATE user_game_state SET proof = 0');
  assert.deepEqual(await game.sweepBattle(USER, same), left, 'lost response can be recovered with no materials left');
});

test('failed receipt storage rolls back debit and rewards; a reset between read and debit blocks the sweep', async () => {
  await reset();
  clear();
  const before = wallet();
  db.exec("CREATE TRIGGER fail_sweep BEFORE INSERT ON reward_claims WHEN NEW.claim_key LIKE 'sweep:%' BEGIN SELECT RAISE(ABORT, 'storage_failed'); END");
  await assert.rejects(game.sweepBattle(USER, request()), /storage_failed/);
  assert.deepEqual(wallet(), before);
  db.exec('DROP TRIGGER fail_sweep');
  const original = db.batch;
  db.batch = async (statements) => {
    db.exec('DELETE FROM reward_claims');
    return original(statements);
  };
  try {
    await assert.rejects(game.sweepBattle(USER, request()), /먼저 격파/);
    assert.deepEqual(wallet(), before);
  } finally { db.batch = original; }
});

test('sweep API requires authentication and returns a receipt on success', async () => {
  await reset();
  clear();
  const post = () => new Request('http://local/api/battle', { method: 'POST', body: JSON.stringify({ action: 'sweep', ...request({ count: 100 }) }) });
  setAuthenticatedUser(null);
  assert.equal((await route.POST(post())).status, 401);
  setAuthenticatedUser(USER, 'sweep@local.invalid', '테스트');
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sweep, { count: 100, cost: 100, ticketType: 'low', quantity: 100 });
});

test('account reset clears sweep history and old requests cannot pay without a new clear and materials', async () => {
  await reset();
  clear();
  const input = request();
  await game.sweepBattle(USER, input);
  await game.resetAccount(USER);
  await assert.rejects(game.sweepBattle(USER, input), /먼저 격파/);
  assert.deepEqual(wallet(), { proof: 0, fragments: 0, pull_credits: 0, low_tickets: 0, sr_tickets: 0, ssr_tickets: 0 });
});
