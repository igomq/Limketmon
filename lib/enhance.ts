// Duplicate-card enhance. Pure data: cost, clamp, stat mul. Server writes; clients only display.
export const MAX_ENHANCE = 5;
/** +8% HP/ATK/DEF per level. Level 5 returns a nerfed base card to about its old raw stats. */
export const ENHANCE_PER_LEVEL = 0.08;

export function clampEnhance(level: number): number {
  if (!Number.isInteger(level) || level < 0) return 0;
  return Math.min(MAX_ENHANCE, level);
}

/** Copies consumed to go from `level` to `level + 1`. First enhance costs 1, then 2, 3, ... */
export function enhanceCost(level: number): number {
  return clampEnhance(level) + 1;
}

/** Keep one copy. Need quantity - cost >= 1. */
export function canEnhance(quantity: number, level: number): boolean {
  const current = clampEnhance(level);
  return current < MAX_ENHANCE && quantity - enhanceCost(current) >= 1;
}

export function applyEnhance<T extends { maxHp: number; atk: number; def: number; crit: number }>(
  stats: T,
  level: number
): T {
  const current = clampEnhance(level);
  if (current === 0) return stats;
  const mul = 1 + current * ENHANCE_PER_LEVEL;
  return {
    ...stats,
    maxHp: Math.max(1, Math.round(stats.maxHp * mul)),
    atk: Math.max(1, Math.round(stats.atk * mul)),
    def: Math.max(1, Math.round(stats.def * mul)),
    crit: stats.crit + Math.floor(current / 2)
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
