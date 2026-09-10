// Minimal D1 shim over node:sqlite, matching the subset the app uses:
// prepare/bind/run/all/first and batch (one transaction).
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');

  const statement = (query, bindings) => ({
    query,
    bindings,
    // D1's PreparedStatement binds into a new statement, and each statement can be
    // executed directly (run/all/first) without a bind() first.
    bind: (...next) => statement(query, next),
    run() {
      // all() both applies the statement and returns any RETURNING rows.
      const rows = sql.prepare(query).all(...bindings);
      const changes = sql.prepare('select changes() as c').get().c;
      return { meta: { changes: Number(changes) }, results: rows, success: true };
    },
    all() {
      return { results: sql.prepare(query).all(...bindings), success: true };
    },
    first() {
      return sql.prepare(query).get(...bindings) ?? null;
    },
    // node:sqlite spelling of first(), for tests that assert on a raw statement.
    get() {
      return sql.prepare(query).get(...bindings) ?? null;
    }
  });

  return {
    prepare(query) {
      return statement(query, []);
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((item) => {
          const rows = sql.prepare(item.query).all(...item.bindings);
          const changes = sql.prepare('select changes() as c').get().c;
          return { results: rows, meta: { changes: Number(changes) }, success: true };
        });
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        // RAISE(ROLLBACK) inside a trigger already ends the transaction, so a second ROLLBACK
        // would throw and hide the real failure.
        try {
          sql.exec('ROLLBACK');
        } catch {
          /* the abort already rolled the transaction back */
        }
        throw error;
      }
    },
    exec(query) {
      sql.exec(query);
    },
    close() {
      sql.close();
    }
  };
}

/** Applies the shipped migration files, so tests always run against the real schema. */
export function migrate(d1, sqlText) {
  for (const chunk of sqlText.split('--> statement-breakpoint')) {
    const trimmed = chunk.trim();
    if (trimmed && !/^pragma\s+optimize/i.test(trimmed)) d1.exec(trimmed);
  }
}
