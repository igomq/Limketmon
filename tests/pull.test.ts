import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { savePull } from '../lib/pull.ts';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';

/** A D1 shim over in-memory SQLite, with every shipped migration applied. */
function migratedDb() {
  const sql = new DatabaseSync(':memory:');
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    for (const chunk of readFileSync(new URL(file, migrationDir), 'utf8').split('--> statement-breakpoint')) {
      if (chunk.trim()) sql.exec(chunk);
    }
  }
  const db = {
    prepare(query: string) {
      return { bind(...bindings: Array<string | number>) { return { query, bindings }; } };
    },
    async batch(statements: Array<{ query: string; bindings: Array<string | number> }>) {
      sql.exec('BEGIN');
      try {
        const results = statements.map(({ query, bindings }) => ({
          results: sql.prepare(query).all(...bindings),
          meta: { changes: Number((sql.prepare('select changes() as c').get() as { c: number }).c) }
        }));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        // RAISE(ROLLBACK) already ended the transaction; preserve the original failure.
        try { sql.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
  } as unknown as D1Database;
  return { sql, db };
}

test('free pulls, five-card charges, and failed grants are atomic', async () => {
  const { sql, db } = migratedDb();
  sql.exec("INSERT INTO users VALUES ('test', 'test@local.invalid', 'now', 'now'); INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date) VALUES ('test', 0, NULL)");
  const card = manifest.cards[0] as Card;
  const today = new Date('2026-09-05T00:00:00Z');
  const credits = () => sql.prepare('SELECT pull_credits FROM user_game_state').get()!.pull_credits;
  const quantity = () => sql.prepare('SELECT quantity FROM inventory').get()?.quantity ?? 0;
  try {
    // The pull no longer takes a pity counter: fromPity/pityTo are ignored compatibility args.
    const free = await savePull(db, 'test', [card], today, 0, 0);
    assert.equal(free[0].usedFreePull, true);
    assert.equal(free[0].isNew, true);
    assert.equal(credits(), 0);
    await assert.rejects(savePull(db, 'test', [card], today, 0, 0), /chk_user_game_state_credits/);
    assert.equal(quantity(), 1);
    sql.exec('UPDATE user_game_state SET pull_credits = 10');
    const five = await savePull(db, 'test', Array(5).fill(card), today, 0, 0);
    assert.deepEqual(five.map((result) => result.quantity), [2, 3, 4, 5, 6]);
    assert.ok(five.every((result) => !result.usedFreePull && !result.isNew));
    assert.equal(credits(), 5);
    sql.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON pull_history BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
    await assert.rejects(savePull(db, 'test', [card], today, 0, 0), /simulated write failure/);
    assert.equal(credits(), 5, 'failed paid grant restores credits');
    assert.equal(quantity(), 6, 'failed grant restores inventory');
    const tomorrow = new Date('2026-09-05T15:00:00Z');
    await assert.rejects(savePull(db, 'test', [card], tomorrow, 0, 0), /simulated write failure/);
    assert.equal(sql.prepare('SELECT last_free_pull_date FROM user_game_state').get()!.last_free_pull_date, '2026-09-05');
    sql.exec('DROP TRIGGER fail_grant');
    const nextDay = await savePull(db, 'test', [card], tomorrow, 0, 0);
    assert.equal(nextDay[0].usedFreePull, true);
    assert.equal(credits(), 5);
  } finally { sql.close(); }
});

test('low ticket pulls spend their own balance and roll back an overdraft', async () => {
  const { sql, db } = migratedDb();
  sql.exec("INSERT INTO users VALUES ('test', 'test@local.invalid', 'now', 'now'); INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, low_tickets) VALUES ('test', 0, NULL, 2)");
  const card = manifest.cards[0] as Card;
  const today = new Date('2026-09-05T00:00:00Z');
  const low = () => sql.prepare('SELECT low_tickets FROM user_game_state').get()!.low_tickets;
  const history = () => sql.prepare('SELECT COUNT(*) AS c FROM pull_history').get()!.c as number;
  try {
    const one = await savePull(db, 'test', [card], today, 0, 0, 'low');
    assert.equal(one[0].usedFreePull, false, 'a low pull never uses the free single');
    assert.equal(low(), 1);
    assert.equal(history(), 1);

    // Two tickets left were already spent down to one: a five-card low pull must roll back whole.
    await assert.rejects(savePull(db, 'test', Array(5).fill(card), today, 0, 0, 'low'), /not_enough_tickets/);
    assert.equal(low(), 1, 'a short low pull leaves the balance untouched');
    assert.equal(history(), 1, 'a short low pull grants no cards');
    assert.equal(sql.prepare('SELECT pull_credits FROM user_game_state').get()!.pull_credits, 0, 'normal credits untouched by a low pull');
  } finally { sql.close(); }
});

