export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR';

export interface CardDefinition {
	id: string;
	version: number;
	name: string;
	rarity: Rarity;
	/** stable asset key, e.g. "v001.jpg" — resolve via resolveCardImage() */
	imageKey: string;
	skillName: string;
	skillDescription: string;
	flavorText: string;
	attack: number;
	defense: number;
	luck: number;
}

/** manifest record: card + provenance used by cards:sync to stay idempotent */
export interface CardRecord extends CardDefinition {
	sourceName: string;
}

export interface InventoryItem {
	cardId: string;
	quantity: number;
	firstObtainedAt: string;
}

export const RARITIES: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR'];

export const RARITY_META: Record<Rarity, { label: string; stars: number }> = {
	N: { label: 'NORMAL', stars: 1 },
	R: { label: 'RARE', stars: 2 },
	SR: { label: 'SUPER RARE', stars: 3 },
	SSR: { label: 'SSR', stars: 4 },
	UR: { label: 'ULTRA RARE', stars: 5 }
};

/** UI-level image resolution: imageKey -> servable URL. Swap here when object storage arrives. */
export function resolveCardImage(imageKey: string): string {
	return `/cards/${imageKey}`;
}
