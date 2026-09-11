export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR' | 'XR';

/**
 * Strongest first. XR is the transcend-only top tier: it is never drawn and never fused, so it
 * appears in the ordering (rank 0) but in no pull table.
 */
export const RARITY_ORDER: Rarity[] = ['XR', 'UR', 'SSR', 'SR', 'R', 'N'];

export type OddsTable = Array<[Rarity, number]>;

/** Which draw table a pull uses: 'normal' spends the credit pool, 'low' spends low tickets. */
export type PullKind = 'normal' | 'low';

/** Normal pull odds: N60 R28 SR10 SSR1.9 UR0.1. The single source of truth for the normal draw. */
export const RARITY_WEIGHTS: OddsTable = [
  ['N', 0.6],
  ['R', 0.28],
  ['SR', 0.1],
  ['SSR', 0.019],
  ['UR', 0.001]
];

/** Low (하급) pull odds: N78 R20 SR1.9 SSR0.1, no UR. */
export const LOW_RARITY_WEIGHTS: OddsTable = [
  ['N', 0.78],
  ['R', 0.2],
  ['SR', 0.019],
  ['SSR', 0.001]
];

export const PULL_ODDS: Record<PullKind, OddsTable> = {
  normal: RARITY_WEIGHTS,
  low: LOW_RARITY_WEIGHTS
};

/** The odds table the pull UI prints for a given balance. */
export function oddsFor(kind: PullKind): OddsTable {
  return PULL_ODDS[kind];
}

export function kstDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Rarity for one draw from the flat table for `kind`. There is no pity ladder: every pull is the
 * same weighted roll, so parallel pulls cannot farm an improved rate.
 */
export function rollRarity(roll: number, kind: PullKind = 'normal'): Rarity {
  let total = 0;
  for (const [rarity, weight] of PULL_ODDS[kind]) {
    total += weight;
    if (roll < total) return rarity;
  }
  return 'N';
}

export function rarityRank(rarity: Rarity): number {
  return RARITY_ORDER.indexOf(rarity);
}

/**
 * Rarity for a guaranteed-pull ticket: never weaker than `min`, otherwise the base weight ratios
 * among the allowed rarities, renormalised to sum to one. Uses the normal table's weights.
 */
export function rollGuaranteedRarity(roll: number, min: 'SR' | 'SSR'): Rarity {
  const allowed: Rarity[] = min === 'SSR' ? ['SSR', 'UR'] : ['SR', 'SSR', 'UR'];
  const pool = RARITY_WEIGHTS.filter(([rarity]) => allowed.includes(rarity));
  const total = pool.reduce((sum, [, weight]) => sum + weight, 0);
  let cumulative = 0;
  for (const [rarity, weight] of pool) {
    cumulative += weight / total;
    if (roll < cumulative) return rarity;
  }
  return allowed[allowed.length - 1]!;
}

