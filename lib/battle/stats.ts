// Deterministic card → battle stat derivation. Pure data: no I/O, no randomness.
// Same card in, same stats out, forever (STAT_RULESET is bumped when that stops being true).
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { abilityFor } from './abilities.ts';
import { ELEMENTS, type CardBattleStats, type Element } from './types.ts';
import { enhancePower } from '../enhance.ts';
import manifest from '../data/cards.curated.json';

export const STAT_RULESET = 3;

/** Base cards sit at 70% of catalog attack/defense so enhance has room to climb. */
const BASE_STAT_SCALE = 0.7;

/**
 * Normalized power anchor for N at level 0, in the HP + 2*ATK + DEF unit. Kept near the old N band
 * so the beginner bracket plays the same; every other rarity is scaled to its POWER_CURVE anchor
 * (R 1.25x, SR 1.55x, SSR 2.4x, UR 3.55x), which is what makes N5=R3=SR0 and friends line up.
 */
const BASE_POWER_ANCHOR = 180;

const RARITIES: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR'];

const RAW_POWER = (card: Card) =>
  40 + Math.round(card.defense * 0.62) +
  Math.max(1, Math.round(card.attack * BASE_STAT_SCALE)) * 2 +
  Math.max(1, Math.round(card.defense * BASE_STAT_SCALE));

/** Per-rarity multiplier that pulls the rarity's mean raw power onto its normalized band. */
const RARITY_SCALE: Record<Rarity, number> = (() => {
  const sums = new Map<Rarity, { total: number; count: number }>(RARITIES.map((rarity) => [rarity, { total: 0, count: 0 }]));
  for (const card of manifest.cards as Card[]) {
    const entry = sums.get(card.rarity);
    if (!entry) continue;
    entry.total += RAW_POWER(card);
    entry.count += 1;
  }
  return Object.fromEntries(
    RARITIES.map((rarity) => {
      const entry = sums.get(rarity)!;
      const mean = entry.count > 0 ? entry.total / entry.count : 1;
      return [rarity, (BASE_POWER_ANCHOR * enhancePower(rarity, 0)) / mean];
    })
  ) as Record<Rarity, number>;
})();

/** Energy cost of the signature skill. Cheap skills fire more often, so low rarity stays viable. */
export const RARITY_COST: Record<Rarity, number> = { N: 2, R: 3, SR: 4, SSR: 5, UR: 6 };

/**
 * Element keyword table, checked in ELEMENTS order (light → shadow → iron → nature → spark),
 * first element with a matching visualTag wins. Anything unmatched falls back to
 * ELEMENTS[card.version % 5] so every card still gets a stable element.
 *
 * light   snow, glare, christmas/holiday props, celebration props, formal wear
 * shadow  dark, obscured, candid/back-of-head, degraded or blurry capture
 * iron    protective gear, uniforms, vehicles, signage, papers
 * nature  water, food, crowds, streets, rain
 * spark   screens, filters, mirrors, animation, low-angle/optical tricks
 */
const ELEMENT_KEYWORDS: Record<Element, string[]> = {
  light: ['snow', 'glare', 'christmas-tree', 'thumb-up', 'peace-sign', 'bouquet', 'formalwear'],
  shadow: [
    'dark-background',
    'eyes-closed',
    'back-view',
    'side-profile',
    'low-quality',
    'low-resolution',
    'mask',
    'negative-space',
    'motion-blur',
    'soft-focus'
  ],
  iron: [
    'glasses',
    'goggles',
    'helmet',
    'winter-gear',
    'winter-jacket',
    'uniform',
    'striped-suit',
    'vehicle',
    'subway',
    'transit',
    'sign',
    'billboard',
    'backpack',
    'papers'
  ],
  nature: ['waterpark', 'wet-hair', 'waterline', 'food', 'spoon', 'chopsticks', 'restaurant', 'crowd', 'street', 'rain-overlay'],
  spark: [
    'distorted-filter',
    'screenshot',
    'screenshot-overlay',
    'animated',
    'gif',
    'mirror-selfie',
    'phone',
    'phone-foreground',
    'cat-filter',
    'filter',
    'recursive-face',
    'circular-crop',
    'collage',
    'layered-composition',
    'countdown-overlay',
    'chat-overlay',
    'low-angle'
  ]
};

export function elementOf(card: Card): Element {
  const tags = card.visualTags ?? [];
  for (const element of ELEMENTS) {
    if (tags.some((tag) => ELEMENT_KEYWORDS[element].includes(tag))) return element;
  }
  return ELEMENTS[card.version % ELEMENTS.length];
}

export function battleStats(card: Card): CardBattleStats {
  const scale = RARITY_SCALE[card.rarity];
  return {
    maxHp: Math.max(1, Math.round((40 + Math.round(card.defense * 0.62)) * scale)),
    atk: Math.max(1, Math.round(card.attack * BASE_STAT_SCALE * scale)),
    def: Math.max(1, Math.round(card.defense * BASE_STAT_SCALE * scale)),
    spd: 10 + Math.floor(card.luck / 4),
    crit: 5 + Math.floor(card.luck / 10),
    element: elementOf(card),
    cost: RARITY_COST[card.rarity],
    ability: abilityFor(card)
  };
}

/** Exposed so tooling/tests can compare a card's derived power to the normalized bands. */
export function rarityScale(rarity: Rarity): number {
  return RARITY_SCALE[rarity];
}

/**
 * Full stat multiplier of a rarity at an enhancement level: the rarity's normalization scale times
 * the power-curve growth from level 0. Numeric ability values (damage, heal, shield, poison/regen
 * ticks) are scaled by this so a card's fixed signature follows the same curve as its stats.
 */
export function enhanceScale(rarity: Rarity, level: number): number {
  return RARITY_SCALE[rarity] * (enhancePower(rarity, level) / enhancePower(rarity, 0));
}
