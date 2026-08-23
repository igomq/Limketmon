import { describe, expect, it } from 'vitest';
import { ensureRarityCoverage, generateCard, mulberry32, rarityFromRoll } from '$lib/card-gen.ts';

const base = { imageKey: 'v001.jpg', sourceName: 'TalkMedia_i_0ad1e38c341b.jpg.jpg' };

describe('card generation determinism', () => {
	it('produces identical metadata for the same image on re-runs', () => {
		const a = generateCard({ ...base, version: 1 });
		const b = generateCard({ ...base, version: 1 });
		expect(a).toEqual(b);
	});

	it('keeps existing cards stable when new images are appended later', () => {
		const first = [generateCard({ ...base, version: 1 })];
		const second = [
			generateCard({ ...base, version: 1 }),
			generateCard({ imageKey: 'v002.jpg', sourceName: 'new-photo.jpg', version: 2 })
		];
		// the v001 card must be byte-identical after the new image joins
		expect(second[0]).toEqual(first[0]);
	});

	it('assigns rarity per the target distribution', () => {
		expect(rarityFromRoll(0.0)).toBe('N');
		expect(rarityFromRoll(0.49)).toBe('N');
		expect(rarityFromRoll(0.5)).toBe('R');
		expect(rarityFromRoll(0.76)).toBe('R');
		expect(rarityFromRoll(0.77)).toBe('SR');
		expect(rarityFromRoll(0.91)).toBe('SSR');
		expect(rarityFromRoll(0.98)).toBe('UR');
	});

	it('names cards with padded version numbers', () => {
		const c = generateCard({ ...base, version: 23 });
		expect(c.id).toBe('imsingyu-v023');
		expect(c.name).toContain('임신규-v023');
	});
});

describe('rarity coverage', () => {
	it('guarantees every rarity exists in a batch of >= 5', () => {
		const cards = Array.from({ length: 45 }, (_, i) =>
			generateCard({ imageKey: `v${i}.jpg`, sourceName: `img${i}.jpg`, version: i + 1 })
		);
		ensureRarityCoverage(cards);
		for (const r of ['N', 'R', 'SR', 'SSR', 'UR'] as const) {
			expect(cards.some((c) => c.rarity === r), `rarity ${r}`).toBe(true);
		}
	});

	it('does nothing for small batches', () => {
		const cards = Array.from({ length: 3 }, (_, i) =>
			generateCard({ imageKey: `v${i}.jpg`, sourceName: `img${i}.jpg`, version: i + 1 })
		);
		const before = cards.map((c) => c.rarity);
		ensureRarityCoverage(cards);
		expect(cards.map((c) => c.rarity)).toEqual(before);
	});
});

describe('seeded rng', () => {
	it('mulberry32 is deterministic and in-range', () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		for (let i = 0; i < 10; i++) {
			const v = a();
			expect(v).toBe(b());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});
