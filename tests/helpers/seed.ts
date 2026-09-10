// Shared fixtures: pick real card ids out of the curated manifest by rarity,
// and grant them to a user so deck/battle tests exercise genuine inventory rows.
import manifest from '../../lib/data/cards.curated.json' with { type: 'json' };

interface RawCard {
  id: string;
  rarity: string;
}

const CARDS = manifest.cards as RawCard[];

/** Returns exactly one id per requested rarity slot, in a stable order. */
export function cardIdsByRarity(plan: Partial<Record<'N' | 'R' | 'SR' | 'SSR' | 'UR', number>>): string[] {
  const ids: string[] = [];
  for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR'] as const) {
    const wanted = plan[rarity] ?? 0;
    const pool = CARDS.filter((card) => card.rarity === rarity).slice(0, wanted);
    if (pool.length < wanted) throw new Error(`not enough ${rarity} cards in the manifest`);
    ids.push(...pool.map((card) => card.id));
  }
  return ids;
}

/** Grants cards at quantity 1, exactly like a real pull would. */
export function seedOwned(db: { exec: (sql: string) => void }, userId: string, cardIds: string[]): void {
  for (const cardId of cardIds) {
    db.exec(
      `INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at) VALUES ('${userId}', '${cardId}', 1, '2026-09-01T00:00:00Z') ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1`
    );
  }
}
