import type { Card } from './cards';
import { kstDate } from './rules.ts';

// D1 batch is one transaction: charging and granting cards must succeed together.
export async function savePull(db: D1Database, userId: string, drawn: Card[], now: Date, fromPity: number, pityTo: number) {
  const count = drawn.length;
  if (count !== 1 && count !== 5) throw new Error('Invalid pull count');
  const today = kstDate(now);
  const pulledAt = now.toISOString();
  const writes = drawn.flatMap((card) => [
    db.prepare(`
      INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1
      RETURNING quantity
    `).bind(userId, card.id, pulledAt),
    db.prepare(`
      INSERT INTO pull_history (id, user_id, card_id, rarity, pulled_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), userId, card.id, card.rarity, pulledAt)
  ]);
  const results = await db.batch([
    db.prepare('SELECT last_free_pull_date FROM user_game_state WHERE user_id = ?').bind(userId),
    db.prepare(`
      UPDATE user_game_state SET
        pull_credits = user_game_state.pull_credits - CASE
          WHEN ? = 1 AND (user_game_state.last_free_pull_date IS NULL OR user_game_state.last_free_pull_date != ?) THEN 0
          ELSE ? END,
        last_free_pull_date = CASE WHEN ? = 1 THEN ? ELSE user_game_state.last_free_pull_date END,
        -- Compare and set, evaluated before the card writes below. A pull whose roll used a
        -- counter another request already advanced writes the -1 sentinel instead, and
        -- trg_user_game_state_pity_guard aborts the whole transaction on it. The abort must
        -- happen inside the transaction: a zero-row UPDATE would let the card writes commit for
        -- free, and a check after the batch would report a failure that already paid out.
        pity_counter = CASE WHEN user_game_state.pity_counter = ? THEN ? ELSE -1 END
      WHERE user_id = ?
    `).bind(
      count,
      today,
      count,
      count,
      today,
      fromPity,
      pityTo,
      userId
    ),
    ...writes
  ]);
  // No charge means the pity compare-and-set lost the race; nothing else was written.
  if (!Number((results[1]?.meta as { changes?: number } | undefined)?.changes ?? 0)) {
    throw new ConcurrentPull();
  }
  const previous = results[0]!.results[0] as { last_free_pull_date: string | null } | undefined;
  return drawn.map((card, index) => {
    const quantity = Number((results[2 + index * 2]!.results[0] as { quantity: number }).quantity);
    return { card, quantity, isNew: quantity === 1, usedFreePull: count === 1 && previous?.last_free_pull_date !== today };
  });
}

/** Raised when another pull advanced the pity counter between our read and our write. */
export class ConcurrentPull extends Error {
  constructor() {
    super('pity_changed');
  }
}
