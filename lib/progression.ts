// Pure card-growth rules: traits, dismantle/fusion payouts, transcendence and the effective card.
// No I/O and no randomness: the server owns state, this module owns the numbers.
import type { Card } from './cards.ts';
import type { Rarity } from './rules.ts';
import { enhancePower } from './enhance.ts';

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

export type TraitId =
  | 'damage'
  | 'synergy'
  | 'resist_earth'
  | 'resist_water'
  | 'resist_fire'
  | 'resist_grass'
  | 'resist_dark';

export interface Trait {
  id: TraitId;
  level: number;
  transcended: boolean;
  spentProof?: number;
  refundEstimated?: boolean;
}

/** One owned card row: the catalog card it came from, its effective rarity and its growth state. */
export interface CardProgress {
  baseCardId: string;
  rarity: Rarity;
  enhanceLevel: number;
  traits: Trait[];
}

export const MAX_TRAIT_LEVEL = 20;
/** A card carries at most two different traits. */
export const MAX_TRAITS = 2;
/** Highest resistance a single resist trait reaches (20 + transcend = 70%). */
export const MAX_RESIST = 0.7;

export const TRAIT_IDS: TraitId[] = [
  'damage',
  'synergy',
  'resist_earth',
  'resist_water',
  'resist_fire',
  'resist_grass',
  'resist_dark'
];

export const TRAIT_LABEL: Record<TraitId, string> = {
  damage: '피해 증가',
  synergy: '연계 강화',
  resist_earth: '대지 저항',
  resist_water: '물 저항',
  resist_fire: '불 저항',
  resist_grass: '풀 저항',
  resist_dark: '암흑 저항'
};

const TRAIT_ID_SET: ReadonlySet<string> = new Set(TRAIT_IDS);

export function clampTraitLevel(level: number): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  return Math.min(MAX_TRAIT_LEVEL, Math.floor(level));
}

/** Base cost of one trait level per rarity. */
const TRAIT_BASE_COST: Record<Rarity, number> = { N: 1, R: 2, SR: 3, SSR: 5, UR: 8, XR: 12 };

/**
 * Cost of the next level, `level` being the current one; every fifth level costs five extra.
 * Selecting a trait pays for level 0 -> 1, so the first cost is traitCost(rarity, 0).
 */
export function traitCost(rarity: Rarity, level: number): number {
  const current = clampTraitLevel(level);
  return TRAIT_BASE_COST[rarity] * (current + 1 + Math.floor(current / 5) * 5);
}

/** Effect of one trait as a fraction: 1% per level plus a 5% step every five, x1.75 transcended. */
export function traitValue(trait: Trait): number {
  const level = clampTraitLevel(trait.level);
  const percent = level + Math.floor(level / 5) * 5;
  return (percent / 100) * (trait.transcended ? 2 : 1);
}

/** Stored traits are JSON. Unknown ids, duplicates and out-of-range levels are dropped, not thrown. */
export function parseTraits(raw: unknown): Trait[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const traits: Trait[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; level?: unknown; transcended?: unknown; spentProof?: unknown; refundEstimated?: unknown };
    if (typeof row.id !== 'string' || !TRAIT_ID_SET.has(row.id)) continue;
    if (traits.some((trait) => trait.id === row.id)) continue;
    traits.push({
      id: row.id as TraitId,
      level: clampTraitLevel(Number(row.level)),
      transcended: row.transcended === true,
      ...(typeof row.spentProof === 'number' && Number.isSafeInteger(row.spentProof) && row.spentProof >= 0 ? { spentProof: row.spentProof } : {}),
      ...(typeof row.refundEstimated === 'boolean' ? { refundEstimated: row.refundEstimated } : {})
    });
  }
  return traits;
}

/** Each transcended trait frees another slot; existing traits are never discarded. */
export function traitSlotLimit(traits: readonly Trait[]): number {
  return Math.max(traits.length, MAX_TRAITS + traits.filter((trait) => trait.transcended).length);
}

// ---------------------------------------------------------------------------
// Rarity ladder, dismantle and fusion
// ---------------------------------------------------------------------------

/** Ascending rarity order. XR sits on top and is reachable only through transcendence. */
export const RARITY_STEPS: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR', 'XR'];

/** The next rarity up, or null at XR (an XR card cannot transcend again). */
export function nextRarity(rarity: Rarity): Rarity | null {
  return RARITY_STEPS[RARITY_STEPS.indexOf(rarity) + 1] ?? null;
}

/** Proof chips paid per card dismantled. */
const DISMANTLE_PROOF: Record<Rarity, number> = { N: 1, R: 3, SR: 6, SSR: 10, UR: 25, XR: 40 };

export function dismantleReward(rarity: Rarity): number {
  return DISMANTLE_PROOF[rarity];
}

/** Chance of one fragment per dismantled card; UR and XR always pay one. */
const FRAGMENT_CHANCE: Record<Rarity, number> = { N: 0.01, R: 0.03, SR: 0.08, SSR: 0.2, UR: 1, XR: 1 };

export function fragmentChance(rarity: Rarity): number {
  return FRAGMENT_CHANCE[rarity];
}

/** Fragments that craft one Twin-Proof evidence. */
export const FRAGMENTS_PER_TWIN_PROOF = 5;

/** Minimum enhance level a material must carry in a 3-card fusion. 2-card fusion has none. */
const FUSION_MIN_ENHANCE: Record<Rarity, number> = { N: 0, R: 0, SR: 1, SSR: 2, UR: 3, XR: 3 };

/**
 * Rarity a fusion produces, or null when the recipe does not exist.
 * 3 copies promote one step (SSR -> UR), but never into XR: UR -> XR and any XR recipe are refused,
 * so fusion cannot mint the transcend-only rarity. 2 copies keep the rarity and only change kind.
 */
export function fusionRarity(rarity: Rarity, count: 2 | 3): Rarity | null {
  if (count === 2) return rarity === 'XR' ? null : rarity;
  const next = nextRarity(rarity);
  return next === null || next === 'XR' ? null : next;
}

export function fusionMinEnhance(rarity: Rarity, count: 2 | 3): number {
  return count === 2 ? 0 : FUSION_MIN_ENHANCE[rarity];
}

// ---------------------------------------------------------------------------
// Transcendence
// ---------------------------------------------------------------------------

export const MIN_TRANSCEND_ENHANCE = 5;
export const MIN_TRANSCEND_TRAIT_LEVEL = 10;
/** Twin-Proof cost by the card's current (possibly already transcended) rarity. */
const TWIN_PROOF_COST_BY_RARITY: Record<Rarity, number> = { N: 1, R: 2, SR: 3, SSR: 4, UR: 5, XR: 5 };

export function twinProofCost(rarity: Rarity): number {
  return TWIN_PROOF_COST_BY_RARITY[rarity];
}

/** One rarity step, +5 enhance, a non-transcended trait at +10, and a card below XR. */
export function canTranscend(progress: CardProgress, traitId: TraitId): boolean {
  if (nextRarity(progress.rarity) === null) return false;
  if (progress.enhanceLevel < MIN_TRANSCEND_ENHANCE) return false;
  const trait = progress.traits.find((entry) => entry.id === traitId);
  return trait !== undefined && !trait.transcended && trait.level >= MIN_TRANSCEND_TRAIT_LEVEL;
}

/** Transcends exactly that trait; enhance level, the other trait and the card identity survive. */
export function applyTranscend(progress: CardProgress, traitId: TraitId): CardProgress | null {
  const next = nextRarity(progress.rarity);
  if (next === null || !canTranscend(progress, traitId)) return null;
  return {
    ...progress,
    rarity: next,
    traits: progress.traits.map((trait) =>
      trait.id === traitId ? { ...trait, transcended: true } : { ...trait }
    )
  };
}

// ---------------------------------------------------------------------------
// Effective card
// ---------------------------------------------------------------------------

/**
 * The card a battle or the UI actually sees for one owned row: the catalog card carrying the owned
 * id and the row's effective rarity. Stats keep the card's own shape and are scaled by the rarity
 * power ratio of the power curves - never by a catalog average, because XR has no catalog cards at
 * all - so a promoted card lands on the target rarity's band with its own stat shape intact.
 */
export function effectiveCard(base: Card, ownedId: string, rarity: Rarity): Card {
  const ratio = enhancePower(rarity, 0) / enhancePower(base.rarity, 0);
  const scale = (value: number) => Math.max(1, Math.round(value * ratio));
  return {
    ...base,
    id: ownedId,
    baseCardId: base.baseCardId ?? base.id,
    rarity,
    attack: scale(base.attack),
    defense: scale(base.defense),
    luck: scale(base.luck)
  };
}
