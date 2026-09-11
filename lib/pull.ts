import type { Card } from './cards';
import { kstDate } from './rules.ts';

/** Which balance a pull spends. 'normal' is the existing credit pool (and the daily free single). */
export type TicketType = 'normal' | 'sr' | 'ssr';

const TICKET_COLUMN: Record<Exclude<TicketType, 'normal'>, string> = { sr: 'sr_tickets', ssr: 'ssr_tickets' };

// D1 batch is one transaction: charging and granting cards must succeed together.
export async function savePull(
  db: D1Database,
  userId: string,
  drawn: Card[],
  now: Date,
  fromPity: number,
  pityTo: number,
  ticketType: TicketType = 'normal'
) {
  const count = drawn.length;
  if (count !== 1 && count !== 5 && count !== 10) throw new Error('Invalid pull count');
  const today = kstDate(now);
  const pulledAt = now.toISOString();
 const writes = drawn.flatMap((card) => [
   db.prepare(`
     INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at)
      SELECT ?, ?, 1, ?
      WHERE EXISTS (SELECT 1 FROM user_game_state WHERE user_id = ?)
      ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1
      RETURNING quantity
    `).bind(userId, card.id, pulledAt, userId),
    db.prepare(`
      INSERT INTO pull_history (id, user_id, card_id, rarity, pulled_at)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM user_game_state WHERE user_id = ?)
    `).bind(crypto.randomUUID(), userId, card.id, card.rarity, pulledAt, userId)
  ]);
  const isNormal = ticketType === 'normal';
  // Normal pulls run the pity compare-and-set (a stale counter writes the -1 sentinel that the
  // guard trigger aborts). Guaranteed ticket pulls never touch pity: a paid SR+/SSR+ ticket must
  // not dilute the normal pity ladder, and the guarded decrement below is their own race check.
  const charge = isNormal
    ? db.prepare(`
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
    `).bind(count, today, count, count, today, fromPity, pityTo, userId)
    : (() => {
        const column = TICKET_COLUMN[ticketType];
        // Unconditional decrement: an overdraft writes a negative value, which
        // trg_user_game_state_ticket_guard turns into a ROLLBACK of the whole batch.
        return db.prepare(`UPDATE user_game_state SET ${column} = ${column} - ? WHERE user_id = ?`).bind(count, userId);
      })();
  let results;
  try {
    results = await db.batch([
      db.prepare('SELECT last_free_pull_date FROM user_game_state WHERE user_id = ?').bind(userId),
      charge,
      ...writes
    ]);
  } catch (error) {
    // The ticket guard aborts inside the transaction, so nothing was granted; surface the shortfall.
    if (!isNormal && error instanceof Error && /not_enough_tickets/.test(error.message)) {
      throw new InsufficientTickets(ticketType);
    }
    throw error;
  }
  // No charge means the compare-and-set lost the race (normal) or the balance was short (ticket).
  if (!Number((results[1]?.meta as { changes?: number } | undefined)?.changes ?? 0)) {
    throw isNormal ? new ConcurrentPull() : new InsufficientTickets(ticketType);
  }
  const previous = results[0]!.results[0] as { last_free_pull_date: string | null } | undefined;
  return drawn.map((card, index) => {
    const quantity = Number((results[2 + index * 2]!.results[0] as { quantity: number }).quantity);
    return {
      card,
      quantity,
      isNew: quantity === 1,
      usedFreePull: isNormal && count === 1 && previous?.last_free_pull_date !== today
    };
  });
}

/** Raised when another pull advanced the pity counter between our read and our write. */
export class ConcurrentPull extends Error {
  constructor() {
    super('pity_changed');
  }
}

/** Raised when the chosen ticket balance cannot cover the pull (checked inside the transaction). */
export class InsufficientTickets extends Error {
  ticketType: Exclude<TicketType, 'normal'>;

  constructor(ticketType: Exclude<TicketType, 'normal'>) {
    super('not_enough_tickets');
    this.ticketType = ticketType;
  }
}
