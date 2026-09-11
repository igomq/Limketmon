export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR';

export const RARITY_ORDER: Rarity[] = ['UR', 'SSR', 'SR', 'R', 'N'];

export const RARITY_WEIGHTS: Array<[Rarity, number]> = [
  ['N', 0.5],
  ['R', 0.27],
  ['SR', 0.14],
  ['SSR', 0.07],
  ['UR', 0.02]
];

export function kstDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function rollRarity(roll: number): Rarity {
  let total = 0;
  for (const [rarity, weight] of RARITY_WEIGHTS) {
    total += weight;
    if (roll < total) return rarity;
  }
  return 'N';
}

export function rarityRank(rarity: Rarity): number {
  return RARITY_ORDER.indexOf(rarity);
}

// ---------------------------------------------------------------------------
// Pull odds and pity
//
// The rarity table above is the single source of truth for every pull. Pity only ever
// moves weight between rarities (never invents weight), so the table always sums to 1.
// ---------------------------------------------------------------------------

/** Pulls without an SSR-or-better before the odds start improving. */
export const SOFT_PITY_AT = 30;
/** The 60th consecutive pull without an SSR-or-better is guaranteed to be one. */
export const HARD_PITY_AT = 60;
/** Weight moved into SSR/UR per pull past the soft pity threshold. */
export const PITY_STEP = 0.02;
/** Ceiling for the soft pity bonus, so the table stays well formed. */
export const PITY_MAX_BONUS = 0.55;

export type OddsTable = Array<[Rarity, number]>;

/** True when the next pull is forced to be SSR or better. */
export function isHardPity(counter: number): boolean {
  return counter + 1 >= HARD_PITY_AT;
}

/** UR chance on the guaranteed pull; SSR takes the rest so the two always sum to one. */
export const HARD_PITY_UR_CHANCE = 0.22;

/** The guaranteed-pull odds. Shared with the UI so the shown table matches the real draw. */
export function hardPityOdds(): OddsTable {
  return [
    ['UR', HARD_PITY_UR_CHANCE],
    ['SSR', 1 - HARD_PITY_UR_CHANCE]
  ];
}

/**
 * Odds for the next pull given the number of consecutive non-SSR+ pulls so far.
 * Always normalised: the weights sum to 1.
 */
export function pityOdds(counter: number): OddsTable {
  const base = RARITY_WEIGHTS.map(([rarity, weight]) => [rarity, weight]) as OddsTable;
  if (counter < SOFT_PITY_AT) return base;
  const bonus = Math.min((counter - SOFT_PITY_AT + 1) * PITY_STEP, PITY_MAX_BONUS);
  const table = new Map<Rarity, number>(base);
  table.set('SSR', (table.get('SSR') ?? 0) + bonus * 0.8);
  table.set('UR', (table.get('UR') ?? 0) + bonus * 0.2);
  // Take the bonus back out of the common rarities, cheapest first.
  let remaining = bonus;
  for (const rarity of ['N', 'R', 'SR'] as Rarity[]) {
    const weight = table.get(rarity) ?? 0;
    const taken = Math.min(weight, remaining);
    table.set(rarity, weight - taken);
    remaining -= taken;
  }
  return RARITY_WEIGHTS.map(([rarity]) => [rarity, table.get(rarity) ?? 0]) as OddsTable;
}

/** Rarity for one pull, honouring soft and hard pity. */
export function rollRarityWithPity(roll: number, counter: number): Rarity {
  if (isHardPity(counter)) return roll < HARD_PITY_UR_CHANCE ? 'UR' : 'SSR';
  let total = 0;
  for (const [rarity, weight] of pityOdds(counter)) {
    total += weight;
    if (roll < total) return rarity;
  }
  return 'N';
}

/**
 * Rarity for a guaranteed-pull ticket: never weaker than `min`, otherwise the base weight ratios
 * among the allowed rarities. Independent of the normal pity ladder by design.
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

/** Pity carries over across days and devices; only an SSR+ resets it. */
export function nextPityCounter(counter: number, rarity: Rarity): number {
  return rarity === 'SSR' || rarity === 'UR' ? 0 : counter + 1;
}

/** Pulls remaining before the hard pity guarantee, as shown in the UI. */
export function untilHardPity(counter: number): number {
  return Math.max(0, HARD_PITY_AT - counter);
}
