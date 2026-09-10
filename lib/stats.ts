// Battle history summarisation. O(n) over the rows: one pass, O(1) map lookups.
export interface BattleRow {
  result: string;
  kind: string;
  opponentId: string;
  kstDate: string;
  createdAt: string;
  deckCards: string[];
  mvpCardId: string | null;
  /** True when a surviving ally ended the battle at or below 10% HP. */
  clutch: boolean;
  damageDealt: number;
}

export interface StatsSummary {
  battles: number;
  wins: number;
  losses: number;
  /** Percent (0..100), rounded to one decimal. */
  winRate: number;
  streak: number;
  bestStreak: number;
  topCards: Array<{ cardId: string; uses: number; wins: number }>;
  /** Deck slots per rarity letter; a card used in three slots counts three times. */
  rarityUsage: Record<string, number>;
  bossClears: number;
  dailyClears: number;
}

const TOP_CARDS = 5;

export function summarizeBattles(
  rows: BattleRow[],
  cardRarityById: Record<string, string>
): StatsSummary {
  let wins = 0;
  let losses = 0;
  let bestStreak = 0;
  let run = 0;
  let bossClears = 0;
  let dailyClears = 0;
  const usage = new Map<string, { uses: number; wins: number }>();
  const rarityUsage: Record<string, number> = {};

  for (const row of rows) {
    const won = row.result === 'won';
    if (won) {
      wins++;
      run++;
      if (run > bestStreak) bestStreak = run;
      if (row.opponentId === 'boss') bossClears++;
      if (row.kind === 'daily') dailyClears++;
    } else {
      if (row.result === 'lost') losses++;
      run = 0;
    }
    for (const cardId of row.deckCards) {
      const entry = usage.get(cardId) ?? { uses: 0, wins: 0 };
      entry.uses++;
      if (won) entry.wins++;
      usage.set(cardId, entry);
      const rarity = cardRarityById[cardId];
      if (rarity !== undefined) rarityUsage[rarity] = (rarityUsage[rarity] ?? 0) + 1;
    }
  }

  // Rows are newest-first, so the current streak is the leading win run.
  let streak = 0;
  for (const row of rows) {
    if (row.result !== 'won') break;
    streak++;
  }

  const topCards = [...usage.entries()]
    .map(([cardId, entry]) => ({ cardId, uses: entry.uses, wins: entry.wins }))
    .sort(
      (a, b) =>
        b.uses - a.uses || b.wins - a.wins || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)
    )
    .slice(0, TOP_CARDS);

  return {
    battles: rows.length,
    wins,
    losses,
    winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : 0,
    streak,
    bestStreak,
    topCards,
    rarityUsage,
    bossClears,
    dailyClears
  };
}
