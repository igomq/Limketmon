import type { Card } from './cards';
import { rarityRank, type Rarity } from './rules.ts';

export type CollectionFilter = {
  query: string;
  rarity: Rarity | 'all';
  ownership: 'all' | 'owned' | 'missing';
  sort: 'rarity' | 'number' | 'recent';
};

export function selectCards(
  cards: Card[],
  inventory: Array<{ cardId: string; firstObtainedAt: string }>,
  filter: CollectionFilter
): Card[] {
  const owned = new Map(inventory.map((item) => [item.cardId, item.firstObtainedAt]));
  const query = filter.query.trim().toLocaleLowerCase('ko');
  return cards.filter((card) =>
    (filter.rarity === 'all' || card.rarity === filter.rarity) &&
    (filter.ownership === 'all' || owned.has(card.id) === (filter.ownership === 'owned')) &&
    (!query || `${card.name} ${card.alias ?? ''} ${card.skillName} ${String(card.version).padStart(3, '0')}`.toLocaleLowerCase('ko').includes(query))
  ).sort((a, b) => {
    if (filter.sort === 'recent') {
      const recent = (owned.get(b.id) ?? '').localeCompare(owned.get(a.id) ?? '');
      if (recent) return recent;
    }
    return (filter.sort === 'rarity' ? rarityRank(a.rarity) - rarityRank(b.rarity) : 0) || a.version - b.version;
  });
}

// Exponential momentum projection, shared by the card deck and detail sheet.
export function projectedPosition(position: number, velocity: number): number {
  return position + (velocity / 1000) * 0.995 / (1 - 0.995);
}

export function cardTitle(card: Card): string {
  return card.alias?.replace(/[「」]/g, '') || card.name;
}
