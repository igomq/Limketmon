import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { after } from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';
import { env } from './helpers/cloudflare-workers.mjs';
import { setAuthenticatedUser } from './helpers/next-headers.mjs';

const db = createD1();
const dir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) migrate(db, readFileSync(new URL(file, dir), 'utf8'));
env.DB = db;
const game = await import('../lib/game.ts');
const route = await import('../app/api/account/reset/route.ts');
after(() => db.close());
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('http://local/api/account/reset', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('reset requires confirmation and identity, clears only that player, and rolls back failures', async () => {
  assert.equal((await route.POST(request({ confirmation: '초기화' }))).status, 401);
  for (const id of ['reset-user', 'other-user']) {
    await game.ensureUser(id, `${id}@local.invalid`);
    await game.redeemCoupon(id, 'LIMKETMON');
    await game.pullCards(id, 1);
    const cardId = (await game.getSnapshot(id)).inventory[0]!.cardId;
    db.prepare("INSERT INTO decks VALUES (?,?,'test',1,'now','now')").bind(id, id).run();
    db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(id, cardId).run();
    db.prepare("UPDATE inventory SET enhance_level=5, traits='[{\"id\":\"damage\",\"level\":10,\"transcended\":false}]' WHERE user_id=?").bind(id).run();
    db.prepare('UPDATE user_game_state SET proof=20,fragments=5,twin_proof=2,sr_tickets=3 WHERE user_id=?').bind(id).run();
    db.prepare("INSERT INTO user_achievements VALUES (?,'first','now')").bind(id).run();
    db.prepare("INSERT INTO reward_claims (user_id,claim_key,claimed_at) VALUES (?,'test','now')").bind(id).run();
    db.prepare("INSERT INTO battles (id,user_id,opponent_id,ruleset_version,seed,deck_cards,kst_date,created_at) VALUES (?,?,'rookie',1,1,'[]','2026-09-12','now')").bind(id, id).run();
  }
  const before = await game.getSnapshot('reset-user');
  const other = await game.getSnapshot('other-user');
  setAuthenticatedUser('reset-user');
  assert.equal((await route.POST(request({ confirmation: 'wrong' }))).status, 400);
  assert.equal((await route.POST(request({ confirmation: '초기화' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.deepEqual(await game.getSnapshot('reset-user'), before);
  db.exec("CREATE TRIGGER reset_failure BEFORE DELETE ON battles WHEN OLD.user_id='reset-user' BEGIN SELECT RAISE(ABORT, 'forced reset failure'); END");
  await assert.rejects(game.resetAccount('reset-user'), /forced reset failure/);
  assert.deepEqual(await game.getSnapshot('reset-user'), before);
  db.exec('DROP TRIGGER reset_failure');
  const response = await route.POST(request({ confirmation: '초기화', userId: 'other-user' }));
  assert.equal(response.status, 200);
  const { snapshot } = await response.json();
  assert.equal(snapshot.inventory.length, 0);
  assert.equal(snapshot.decks.length, 0);
  assert.equal(snapshot.credits, 0);
  assert.equal(snapshot.freeAvailable, true);
  assert.deepEqual(snapshot.tickets, { low: 0, sr: 0, ssr: 0 });
  assert.deepEqual(snapshot.materials, { proof: 0, fragments: 0, twinProof: 0 });
  for (const table of ['inventory', 'decks', 'battles', 'pull_history', 'reward_claims', 'user_achievements', 'coupon_redemptions']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).bind('reset-user').first().n, 0, table);
  }
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').bind('reset-user').first());
  assert.deepEqual(await game.getSnapshot('other-user'), other);
  assert.equal((await game.redeemCoupon('reset-user', 'LIMKETMON')).snapshot.credits, 10);
  assert.equal((await game.pullCards('reset-user', 1)).results[0]!.usedFreePull, true);
});
