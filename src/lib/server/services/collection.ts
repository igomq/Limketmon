import type { CardDefinition } from '$lib/cards.ts';
import { getAllCards } from '$lib/server/cards-registry.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';

export interface CollectionEntry {
	card: CardDefinition;
	quantity: number | null; // null = not owned
	firstObtainedAt: string | null;
}

export async function getCollection(repos: Repositories, userId: string): Promise<CollectionEntry[]> {
	const inventory = await repos.game.getInventory(userId);
	const owned = new Map(inventory.map((item) => [item.cardId, item]));
	return getAllCards().map((card) => ({
		card,
		quantity: owned.get(card.id)?.quantity ?? null,
		firstObtainedAt: owned.get(card.id)?.firstObtainedAt ?? null
	}));
}
