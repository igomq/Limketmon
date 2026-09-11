// Deterministic card → battle stat derivation. Pure data: no I/O, no randomness.
// Same card in, same stats out, forever (STAT_RULESET is bumped when that stops being true).
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { abilityFor } from './abilities.ts';
import { ELEMENTS, type CardBattleStats, type Element } from './types.ts';

export const STAT_RULESET = 2;

/** Extra HP per rarity. Rarity buys durability, never raw efficiency. */
const RARITY_HP_BONUS: Record<Rarity, number> = { N: 0, R: 6, SR: 12, SSR: 20, UR: 26 };

/** Base cards sit at 70% of catalog attack/defense so enhance has room to climb. */
const BASE_STAT_SCALE = 0.7;

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
  return {
    maxHp: 40 + Math.round(card.defense * 0.62) + RARITY_HP_BONUS[card.rarity],
    atk: Math.max(1, Math.round(card.attack * BASE_STAT_SCALE)),
    def: Math.max(1, Math.round(card.defense * BASE_STAT_SCALE)),
    spd: 10 + Math.floor(card.luck / 4),
    crit: 5 + Math.floor(card.luck / 10),
    element: elementOf(card),
    cost: RARITY_COST[card.rarity],
    ability: abilityFor(card)
  };
}
