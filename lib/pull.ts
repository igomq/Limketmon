import type { Card } from './cards';
import { kstDate } from './rules.ts';

/**
 * Which balance a pull spends. 'normal' is the credit pool (and the daily free single); 'low',
 * 'sr' and 'ssr' each spend their own guaranteed ticket column.
 */
export type TicketType = 'low' | 'normal' | 'sr' | 'ssr';

/** Korean labels for receipt lines and the pull UI. */
export const TICKET_LABEL: Record<TicketType, string> = {
  low: '하급 뽑기권',
  normal: '보통 뽑기권',
  sr: 'SR 이상 뽑기권',
  ssr: 'SSR 이상 뽑기권'
};

const TICKET_COLUMN: Record<Exclude<TicketType, 'normal'>, string> = {
  low: 'low_tickets',
  sr: 'sr_tickets',
  ssr: 'ssr_tickets'
};

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
  // fromPity/pityTo are retained only so old callers keep compiling; the pull no longer consults
  // or updates a pity counter.
  void fromPity;
  void pityTo;
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
  // The normal pool charges credits, except the daily free single: a one-card pull with no KST
  // date recorded yet costs nothing. Guaranteed tickets decrement their own column unconditionally;
  // an overdraft writes a negative value that trg_user_game_state_ticket_guard turns into a ROLLBACK.
  const charge = isNormal
    ? db.prepare(`
      UPDATE user_game_state SET
        pull_credits = user_game_state.pull_credits - CASE
          WHEN ? = 1 AND (user_game_state.last_free_pull_date IS NULL OR user_game_state.last_free_pull_date != ?) THEN 0
          ELSE ? END,
        last_free_pull_date = CASE WHEN ? = 1 THEN ? ELSE user_game_state.last_free_pull_date END
      WHERE user_id = ?
    `).bind(count, today, count, count, today, userId)
    : (() => {
        const column = TICKET_COLUMN[ticketType];
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
  // No charge means the account has no user_game_state row (the UPDATE matched nothing). The card
  // writes carry the same EXISTS guard, so nothing was granted and the caller sees a failure.
  if (!Number((results[1]?.meta as { changes?: number } | undefined)?.changes ?? 0)) {
    if (!isNormal) throw new InsufficientTickets(ticketType);
    throw new MissingPullState();
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

/** Raised when the account has no game-state row, so nothing can be charged or granted. */
export class MissingPullState extends Error {
  constructor() {
    super('pull_state_missing');
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
