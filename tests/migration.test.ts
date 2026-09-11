// Verifies the shipped D1 migrations the same way the deploy applies them: every file in
// drizzle/ in journal order, against a real SQLite database. Also guards the two things that
// would hurt most in production: a destructive migration, and schema.ts drifting from the SQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createD1, migrate } from './helpers/d1.mjs';

const dir = new URL('../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', dir), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const files = [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag + '.sql');
const sqlOf = (name: string) => readFileSync(new URL(name, dir), 'utf8');

function columns(sql: DatabaseSync, table: string): string[] {
  return (sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function tables(sql: DatabaseSync): string[] {
  return (sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

test('every migration applies to a fresh database and creates the full schema', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    for (const file of files) migrate({ exec: (statement: string) => sql.exec(statement) }, sqlOf(file));

    assert.deepEqual(tables(sql).sort(), [
      'battles',
      'coupon_redemptions',
      'deck_cards',
      'decks',
      'inventory',
      'pull_history',
      'reward_claims',
      'user_achievements',
      'user_game_state',
      'users'
    ]);
    // The columns the game layer writes must exist, with the defaults the code assumes.
    assert.deepEqual(columns(sql, 'user_game_state').sort(), [
      'fragments',
      'last_free_pull_date',
      'low_tickets',
      'pity_counter',
      'proof',
      'pull_credits',
      'sr_tickets',
      'ssr_tickets',
      'twin_proof',
      'user_id'
    ]);
    assert.ok(columns(sql, 'battles').includes('decisions'));
    assert.ok(columns(sql, 'battles').includes('summary'));
    assert.ok(columns(sql, 'battles').includes('clutch'));
    assert.ok(columns(sql, 'battles').includes('ruleset_version'));
    assert.ok(columns(sql, 'battles').includes('mode'));
    assert.ok(columns(sql, 'inventory').includes('enhance_level'));
    // The 0003 delta must not re-add the column 0002 already created.
    assert.equal(columns(sql, 'inventory').filter((name) => name === 'enhance_level').length, 1);
    assert.ok(columns(sql, 'reward_claims').includes('ticket_type'));
    assert.ok(columns(sql, 'reward_claims').includes('ticket_quantity'));
    // Every pull_history read filters by user, so the index must exist on user_id.
    const pullIndexes = (sql.prepare("PRAGMA index_list('pull_history')").all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(pullIndexes.includes('idx_pull_history_user'), 'pull_history needs a user_id index');
    const defaults = new Map(
      (sql.prepare('PRAGMA table_info(battles)').all() as Array<{ name: string; dflt_value: string | null }>).map((row) => [row.name, row.dflt_value])
    );
    assert.equal(defaults.get('result'), "'pending'");
    assert.equal(defaults.get('decisions'), "'[]'");
    assert.equal(defaults.get('modifier'), '\'{"kind":"none"}\'');
    // Deck slots are bounded to the three slots the engine reads.
    const slotCheck = sql
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deck_cards'")
      .get() as { sql: string };
    assert.match(slotCheck.sql, /slot[\s\S]*<\s*3/);
  } finally {
    sql.close();
  }
});

test('migrations are additive: existing rows and tables survive the upgrade', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec('PRAGMA foreign_keys = ON');
    // Play the production upgrade: the old schema with live data, then the new migration.
    migrate({ exec: (statement: string) => sql.exec(statement) }, sqlOf(files[0]!));
    sql.exec(`
      INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@x', '2026-09-01', '2026-09-01');
      INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date) VALUES ('u1', 42, '2026-09-09');
      INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at) VALUES ('u1', 'imsingyu-v001', 3, '2026-09-01');
      INSERT INTO pull_history (id, user_id, card_id, rarity, pulled_at) VALUES ('p1', 'u1', 'imsingyu-v001', 'SR', '2026-09-01');
      INSERT INTO coupon_redemptions (user_id, coupon_code, redeemed_at) VALUES ('u1', 'LIMKETMON', '2026-09-01');
    `);

    for (const file of files.slice(1)) migrate({ exec: (statement: string) => sql.exec(statement) }, sqlOf(file));

    const state = sql.prepare('SELECT pull_credits, last_free_pull_date, pity_counter, sr_tickets, ssr_tickets FROM user_game_state WHERE user_id = ?').get('u1') as {
      pull_credits: number;
      last_free_pull_date: string;
      pity_counter: number;
      sr_tickets: number;
      ssr_tickets: number;
    };
    assert.equal(state.pull_credits, 42, 'credits survive');
    assert.equal(state.last_free_pull_date, '2026-09-09', 'the KST free-pull date survives');
    assert.equal(state.pity_counter, 0, 'existing accounts start with a clean pity counter');
    assert.equal(state.sr_tickets, 0, 'new ticket columns backfill at 0');
    assert.equal(state.ssr_tickets, 0, 'new ticket columns backfill at 0');
    assert.equal((sql.prepare('SELECT quantity FROM inventory WHERE user_id = ?').get('u1') as { quantity: number }).quantity, 3);
    assert.equal((sql.prepare('SELECT enhance_level FROM inventory WHERE user_id = ?').get('u1') as { enhance_level: number }).enhance_level, 0);
    assert.equal((sql.prepare('SELECT COUNT(*) AS c FROM pull_history').get() as { c: number }).c, 1);
    assert.equal((sql.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions').get() as { c: number }).c, 1);
  } finally {
    sql.close();
  }
});

test('no migration drops or rebuilds a pre-existing table', () => {
  const original = new Set([
    'users',
    'user_game_state',
    'inventory',
    'coupon_redemptions',
    'pull_history'
  ]);
  for (const file of files.slice(1)) {
    const sql = sqlOf(file);
    for (const match of sql.matchAll(/DROP TABLE [`"]?(\w+)[`"]?/gi)) {
      assert.ok(!original.has(match[1]!), `${file} drops ${match[1]} — that destroys live data`);
    }
    assert.ok(!/ALTER TABLE [`"]?\w+[`"]? RENAME/i.test(sql), `${file} renames a table`);
  }
});

test('db/schema.ts and the migrations agree on the table set', () => {
  const schema = readFileSync(new URL('../db/schema.ts', import.meta.url), 'utf8');
  const declared = [...schema.matchAll(/sqliteTable\(\s*'([a-z_]+)'/g)].map((match) => match[1]!).sort();
  const sql = new DatabaseSync(':memory:');
  try {
    for (const file of files) migrate({ exec: (statement: string) => sql.exec(statement) }, sqlOf(file));
    assert.deepEqual(declared, tables(sql).sort(), 'run pnpm db:generate after editing db/schema.ts');
  } finally {
    sql.close();
  }
});

test('the migrated schema accepts the app write path', () => {
  // A smoke test through the D1 shim: the exact statements lib/pull.ts and lib/game.ts issue must
  // run against the real migrated schema, including the RETURNING clause.
  const d1 = createD1();
  for (const file of files) migrate(d1, sqlOf(file));
  d1.exec("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@x', '2026-09-01', '2026-09-01')");
  d1.exec("INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date) VALUES ('u1', 10, NULL)");
  return import('../lib/pull.ts').then(async ({ savePull }) => {
    const card = { id: 'imsingyu-v001', rarity: 'SR' } as Parameters<typeof savePull>[2][number];
    // fromPity/pityTo are ignored compatibility args; the batch charges five credits for five cards.
    const results = await savePull(d1 as unknown as D1Database, 'u1', [card, card, card, card, card], new Date('2026-09-10T03:00:00Z'), 0, 0);
    assert.deepEqual(results.map((row) => row.quantity), [1, 2, 3, 4, 5]);
    const state = await d1.prepare('SELECT pull_credits, pity_counter FROM user_game_state WHERE user_id = ?').bind('u1').first() as {
      pull_credits: number;
      pity_counter: number;
    };
    assert.equal(state.pull_credits, 5, 'five pulls charge five credits in the same transaction');
    assert.equal(state.pity_counter, 0, 'the pull no longer writes the pity column');
    d1.close();
  });
});
