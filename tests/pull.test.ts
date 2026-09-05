import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { savePull } from '../lib/pull.ts';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';

test('free pulls, five-card charges, and failed grants are atomic', async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0000_zippy_anthem.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users VALUES ('test', 'test@local.invalid', 'now', 'now'); INSERT INTO user_game_state VALUES ('test', 0, NULL)");
  const db = {
    prepare(query: string) {
      return { bind(...bindings: Array<string | number>) { return { query, bindings }; } };
    },
    async batch(statements: Array<{ query: string; bindings: Array<string | number> }>) {
      sql.exec('BEGIN');
      try {
        const results = statements.map(({ query, bindings }) => ({ results: sql.prepare(query).all(...bindings) }));
        sql.exec('COMMIT');
        return results;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  } as unknown as D1Database;
  const card = manifest.cards[0] as Card;
  const today = new Date('2026-09-05T00:00:00Z');
  const credits = () => sql.prepare('SELECT pull_credits FROM user_game_state').get()!.pull_credits;
  const quantity = () => sql.prepare('SELECT quantity FROM inventory').get()?.quantity ?? 0;
  try {
    const free = await savePull(db, 'test', [card], today);
    assert.equal(free[0].usedFreePull, true);
    assert.equal(free[0].isNew, true);
    assert.equal(credits(), 0);
    await assert.rejects(savePull(db, 'test', [card], today), /chk_user_game_state_credits/);
    assert.equal(quantity(), 1);
    sql.exec('UPDATE user_game_state SET pull_credits = 10');
    const five = await savePull(db, 'test', Array(5).fill(card), today);
    assert.deepEqual(five.map((result) => result.quantity), [2, 3, 4, 5, 6]);
    assert.ok(five.every((result) => !result.usedFreePull && !result.isNew));
    assert.equal(credits(), 5);
    sql.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON pull_history BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
    await assert.rejects(savePull(db, 'test', [card], today), /simulated write failure/);
    assert.equal(credits(), 5, 'failed paid grant restores credits');
    assert.equal(quantity(), 6, 'failed grant restores inventory');
    const tomorrow = new Date('2026-09-05T15:00:00Z');
    await assert.rejects(savePull(db, 'test', [card], tomorrow), /simulated write failure/);
    assert.equal(sql.prepare('SELECT last_free_pull_date FROM user_game_state').get()!.last_free_pull_date, '2026-09-05');
    sql.exec('DROP TRIGGER fail_grant');
    const nextDay = await savePull(db, 'test', [card], tomorrow);
    assert.equal(nextDay[0].usedFreePull, true);
    assert.equal(credits(), 5);
  } finally { sql.close(); }
});
