// Deterministic card → battle stat derivation. Pure data: no I/O, no randomness.
// Same card in, same stats out, forever (STAT_RULESET is bumped when that stops being true).
import type { Card } from '../cards.ts';
import type { Rarity } from '../rules.ts';
import { abilityFor } from './abilities.ts';
import { ELEMENTS, type CardBattleStats, type Element } from './types.ts';
import { enhancePower } from '../enhance.ts';
import manifest from '../data/cards.curated.json';

export const STAT_RULESET = 6;

/** Base cards sit at 70% of catalog attack/defense so enhance has room to climb. */
const BASE_STAT_SCALE = 0.7;
/** Fights were ending in a few hits; HP/DEF go up, ATK goes down. */
const HP_MULT = 1.22;
const ATK_MULT = 1.0;
const DEF_MULT = 1.06;

/**
 * Normalized power anchor for N at level 0, in the HP + 2*ATK + DEF unit. Kept near the old N band
 * so the beginner bracket plays the same; every other rarity is scaled to its POWER_CURVE anchor
 * (R 1.25x, SR 1.55x, SSR 2.4x, UR 3.55x), which is what makes N5=R3=SR0 and friends line up.
 */
const BASE_POWER_ANCHOR = 180;

/** The six live rarities, weakest first. XR is the only one with no catalog cards of its own. */
export const RARITIES: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR', 'XR'];

/**
 * XR has no catalog cards: it only ever exists as another row's transcended upgrade, so it must
 * never be averaged into the manifest like a base rarity (that would invent a band out of
 * nothing). Instead it shares UR's normalization scale, because effectiveCard already multiplies
 * the promoted row's raw attack/defense/luck by the power-curve ratio (UR x 1.35). Applying the
 * ratio here as well would square it: a transcended card would reach 1.82x its UR form instead of
 * the intended 1.35x.
 */

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
  const scales = new Map<Rarity, number>();
  for (const rarity of RARITIES) {
    const entry = sums.get(rarity)!;
    if (entry.count === 0) continue;
    scales.set(rarity, (BASE_POWER_ANCHOR * enhancePower(rarity, 0)) / (entry.total / entry.count));
  }
  // XR shares the UR scale; the 1.35 lives in its raw stats (see the note above).
  scales.set('XR', scales.get('UR')!);
  return Object.fromEntries(scales) as Record<Rarity, number>;
})();

/** Energy cost of the signature skill. Cheap skills fire more often, so low rarity stays viable. */
export const RARITY_COST: Record<Rarity, number> = { N: 2, R: 3, SR: 4, SSR: 5, UR: 6, XR: 7 };

/**
 * Element keyword table, checked in ELEMENTS order (earth → water → fire → grass → dark), and the
 * first element with a matching visualTag wins. Anything unmatched falls back to
 * ELEMENTS[card.version % 5] so every card still gets a stable element.
 *
 * earth   protective gear, uniforms, vehicles, transit, signage, papers — things that stand still
 * water   waterparks, wet hair, life jackets, rain, snow, hazy lenses
 * fire    celebration props, gestures, glare — warmth and energy
 * grass   food, restaurants, crowds, streets, outdoor scenes
 * dark    obscured, candid or degraded captures, screens and photo filters
 */
const ELEMENT_KEYWORDS: Record<Element, string[]> = {
  earth: [
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
    'backpack',
    'papers'
  ],
  water: ['waterpark', 'wet-hair', 'life-jacket', 'waterline', 'rain-overlay', 'snow', 'lens-haze'],
  fire: [
    'glare',
    'christmas-tree',
    'thumb-up',
    'peace-sign',
    'bouquet',
    'formalwear',
    'raised-hands',
    'clasped-hands',
    'hand-gesture'
  ],
  grass: [
    'food',
    'spoon',
    'chopsticks',
    'restaurant',
    'crowd',
    'street',
    'group',
    'outdoor',
    'classroom',
    'sign',
    'billboard'
  ],
  dark: [
    'dark-background',
    'eyes-closed',
    'back-view',
    'side-profile',
    'low-quality',
    'low-resolution',
    'mask',
    'negative-space',
    'motion-blur',
    'soft-focus',
    'low-angle',
    'surreal-composite',
    'extreme-composition',
    'accidental-framing',
    'head-down'
  ]
};

export function elementOf(card: Card): Element {
  const tags = card.visualTags ?? [];
  for (const element of ELEMENTS) {
    if (tags.some((tag) => ELEMENT_KEYWORDS[element].includes(tag))) return element;
  }
  return ELEMENTS[card.version % ELEMENTS.length];
}

const CATALOG_BY_ID: Map<string, Card> = new Map((manifest.cards as Card[]).map((card) => [card.id, card]));

/** Catalog row used for abilities, visual tags and rarity normalization. Owned UUID rows point here via baseCardId. */
export function catalogCard(card: Card): Card {
  return CATALOG_BY_ID.get(card.baseCardId ?? card.id) ?? card;
}

export function battleStats(card: Card): CardBattleStats {
  const catalog = catalogCard(card);
  // Normalize with the original catalog rarity. effectiveCard already applied the power-curve
  // ratio, so using the promoted rarity's scale here would raise the card twice (and square XR).
  const scale = RARITY_SCALE[catalog.rarity];
  const derived: Card = {
    ...catalog,
    rarity: card.rarity,
    attack: card.attack,
    defense: card.defense,
    luck: card.luck
  };
  return {
    maxHp: Math.max(1, Math.round((40 + Math.round(card.defense * 0.62)) * scale * HP_MULT)),
    atk: Math.max(1, Math.round(card.attack * BASE_STAT_SCALE * scale * ATK_MULT)),
    def: Math.max(1, Math.round(card.defense * BASE_STAT_SCALE * scale * DEF_MULT)),
    spd: 10 + Math.floor(card.luck / 4),
    crit: 5 + Math.floor(card.luck / 10),
    element: elementOf(catalog),
    cost: RARITY_COST[card.rarity],
    ability: abilityFor(derived)
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
