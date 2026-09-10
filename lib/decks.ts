// Deck rules. Pure: no I/O, no framework imports. The curated manifest is the
// only rarity source, so validateDeck can enforce a rarity cap on its own.
import manifest from './data/cards.curated.json' with { type: 'json' };
import type { Card } from './cards.ts';
import { rarityRank, type Rarity } from './rules.ts';

export const DECK_SIZE = 3;
export const MAX_DECKS = 10;
export const DECK_NAME_MAX = 24;

const CARD_RARITY = new Map<string, Rarity>(
  (manifest.cards as Card[]).map((card) => [card.id, card.rarity])
);

/** Trimmed deck name, or null when the caller supplied nothing usable. */
export function normalizeDeckName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name ? name.slice(0, DECK_NAME_MAX) : null;
}

export function isDuplicateCardList(cardIds: string[]): boolean {
  return new Set(cardIds).size !== cardIds.length;
}

/** One owned copy is enough: inventory quantity never enters this check. */
export function validateDeck(
  cardIds: unknown,
  owned: Set<string>,
  options?: { maxRarity?: Rarity }
): { ok: true; cards: string[] } | { ok: false; error: string } {
  if (!Array.isArray(cardIds)) {
    return { ok: false, error: `덱은 정확히 ${DECK_SIZE}장의 카드로 구성해야 합니다.` };
  }
  const list: unknown[] = cardIds;
  if (list.length !== DECK_SIZE) {
    return { ok: false, error: `덱은 정확히 ${DECK_SIZE}장의 카드로 구성해야 합니다.` };
  }
  const cards: string[] = [];
  for (const id of list) {
    if (typeof id !== 'string') return { ok: false, error: '카드 정보가 올바르지 않습니다.' };
    cards.push(id);
  }
  if (isDuplicateCardList(cards)) {
    return { ok: false, error: '같은 카드를 중복으로 넣을 수 없습니다.' };
  }
  for (const cardId of cards) {
    if (!owned.has(cardId)) return { ok: false, error: '보유하지 않은 카드입니다.' };
  }
  const cap = options?.maxRarity;
  if (cap !== undefined) {
    const capRank = rarityRank(cap);
    for (const cardId of cards) {
      const rarity = CARD_RARITY.get(cardId);
      // RARITY_ORDER runs strongest-first (UR = 0 ... N = 4), so "X 이하" means the rank
      // must be at or BELOW the cap's rank number.
      if (rarity === undefined || rarityRank(rarity) < capRank) {
        return { ok: false, error: `이번 규칙에서는 ${cap} 등급 이하 카드만 사용할 수 있습니다.` };
      }
    }
  }
  return { ok: true, cards };
}
