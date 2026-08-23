import manifest from '$lib/data/cards.generated.json';
import type { CardDefinition, CardRecord, Rarity } from '$lib/cards.ts';
import { RARITIES } from '$lib/cards.ts';

const records = (manifest as { cards: CardRecord[] }).cards;
const byId = new Map(records.map((c) => [c.id, c]));
const byRarity = new Map<Rarity, CardDefinition[]>(RARITIES.map((r) => [r, []]));
for (const { sourceName: _sourceName, ...card } of records) {
	byRarity.get(card.rarity)!.push(card);
}

export function getAllCards(): CardDefinition[] {
	return records.map(({ sourceName: _s, ...c }) => c);
}

export function getCardById(id: string): CardDefinition | undefined {
	return byId.get(id);
}

export function cardsOfRarity(rarity: Rarity): CardDefinition[] {
	return byRarity.get(rarity) ?? [];
}
