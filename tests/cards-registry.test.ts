import { describe, expect, it } from 'vitest';
import { RARITIES } from '$lib/cards.ts';
import { cardsOfRarity, getAllCards, getCardById } from '$lib/server/cards-registry.ts';

describe('generated card manifest', () => {
	it('has unique stable ids, versions and image keys', () => {
		const cards = getAllCards();
		expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length);
		expect(new Set(cards.map((card) => card.version)).size).toBe(cards.length);
		expect(new Set(cards.map((card) => card.imageKey)).size).toBe(cards.length);
		for (const card of cards) {
			expect(card.id).toBe(`imsingyu-v${String(card.version).padStart(3, '0')}`);
			expect(card.imageKey).toMatch(/^v\d{3}\.(?:jpe?g|png|webp|avif)$/);
			expect(getCardById(card.id)?.imageKey).toBe(card.imageKey);
		}
	});

	it('keeps every rarity pool available for pulling', () => {
		for (const rarity of RARITIES) expect(cardsOfRarity(rarity).length).toBeGreaterThan(0);
	});
});
