export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR';

export const RARITY_ORDER: Rarity[] = ['UR', 'SSR', 'SR', 'R', 'N'];

const WEIGHTS: Array<[Rarity, number]> = [
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
  for (const [rarity, weight] of WEIGHTS) {
    total += weight;
    if (roll < total) return rarity;
  }
  return 'N';
}

export function rarityRank(rarity: Rarity): number {
  return RARITY_ORDER.indexOf(rarity);
}
