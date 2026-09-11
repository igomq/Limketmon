// Duplicate-card enhance. Pure data: cost, clamp, stat mul. Server writes; clients only display.
import type { Rarity } from './rules.ts';

export const MAX_ENHANCE = 15;

/**
 * Normalized power band per rarity. The curves are tuned so equal landmarks line up:
 * N5=R3=SR0, N10=R5=SR2=SSR0, N15=R10=SR6=SSR3=UR0. They are abstract units, not raw stats:
 * battleStats anchors each rarity to its level-0 band and applyEnhance scales by the ratio.
 */
const POWER_CURVE: Record<Rarity, (level: number) => number> = {
  N: (level) => 1 + 0.08 * level + 0.006 * level * level,
  R: (level) => 1.25 + 0.1 * level + 0.013 * level * level,
  SR: (level) => 1.55 + 0.3 * level + 0.006 * level * level,
  SSR: (level) => 2.4 + 0.32 * level + 0.022 * level * level,
  UR: (level) => 3.55 + 0.4 * level + 0.025 * level * level
};

/** Normalized power of a rarity at an enhancement level. Strictly increasing in `level`. */
export function enhancePower(rarity: Rarity, level: number): number {
  return POWER_CURVE[rarity](clampEnhance(level));
}

export function clampEnhance(level: number): number {
  if (!Number.isInteger(level) || level < 0) return 0;
  return Math.min(MAX_ENHANCE, level);
}

/** Copies consumed to go from `level` to `level + 1`. First enhance costs 1, then 2, 3, ... */
export function enhanceCost(level: number): number {
  return clampEnhance(level) + 1;
}

/** One copy is kept as the base card; only the rest can be spent. Total quantity is stored as-is. */
export function enhanceMaterials(quantity: number): number {
  const total = Number.isFinite(quantity) ? Math.floor(quantity) : 0;
  return Math.max(0, total - 1);
}

/** Keep one copy. Need quantity - cost >= 1, i.e. materials >= cost. */
export function canEnhance(quantity: number, level: number): boolean {
  const current = clampEnhance(level);
  return current < MAX_ENHANCE && enhanceMaterials(quantity) >= enhanceCost(current);
}

export function applyEnhance<T extends { maxHp: number; atk: number; def: number; crit: number }>(
  stats: T,
  level: number,
  rarity: Rarity = 'N'
): T {
  const current = clampEnhance(level);
  if (current === 0) return stats;
  // Ratio to the rarity's level-0 band, so an enhanced card keeps its own stat shape.
  const mul = POWER_CURVE[rarity](current) / POWER_CURVE[rarity](0);
  return {
    ...stats,
    maxHp: Math.max(1, Math.round(stats.maxHp * mul)),
    atk: Math.max(1, Math.round(stats.atk * mul)),
    def: Math.max(1, Math.round(stats.def * mul)),
    // Crit grows slowly and stays inside a sane 5..40 percent band.
    crit: Math.min(40, stats.crit + Math.floor(current / 3))
  };
}

export interface DeckSlot {
  id: string;
  enhance: number;
}

/** Old battles stored string ids; new ones store {id, lv}. Missing level is 0. */
export function parseDeckSlots(raw: unknown): DeckSlot[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const slots: DeckSlot[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) {
      slots.push({ id: item, enhance: 0 });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; lv?: unknown; enhance?: unknown };
    if (typeof row.id !== 'string' || !row.id) continue;
    slots.push({ id: row.id, enhance: clampEnhance(Number(row.lv ?? row.enhance ?? 0)) });
  }
  return slots;
}
