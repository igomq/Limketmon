import { describe, expect, it, beforeEach } from 'vitest';
import { resetMockDb } from '$lib/server/repositories/mock/db.ts';
import { MockAuthRepository } from '$lib/server/repositories/mock/auth.ts';
import { MockGameRepository } from '$lib/server/repositories/mock/game.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';
import { getPullStatus, pullCard } from '$lib/server/services/pulls.ts';
import { signup } from '$lib/server/services/auth.ts';
import { ServiceError } from '$lib/server/errors.ts';

function makeRepos(): Repositories {
	return { auth: new MockAuthRepository(), game: new MockGameRepository() };
}

async function seeded(): Promise<{ repos: Repositories; userId: string }> {
	const repos = makeRepos();
	const user = await signup(repos, 'puller@test.io', 'password123');
	return { repos, userId: user.id };
}

/** rand that always lands on the first N-rarity roll */
const randN = () => 0.1;

beforeEach(() => resetMockDb());

describe('daily free pull (KST)', () => {
	it('first pull of the day is free', async () => {
		const { repos, userId } = await seeded();
		const clock = () => new Date('2026-08-23T05:00:00Z'); // 14:00 KST
		const result = await pullCard({ repos, userId, rand: randN, clock });
		expect(result.usedFreePull).toBe(true);
	});

	it('second pull on the same KST date is not free', async () => {
		const { repos, userId } = await seeded();
		const clock = () => new Date('2026-08-23T05:00:00Z'); // 14:00 KST
		await pullCard({ repos, userId, rand: randN, clock });
		// 14:59 UTC same KST day, no credits -> rejected
		await expect(
			pullCard({ repos, userId, rand: randN, clock: () => new Date('2026-08-23T14:59:00Z') })
		).rejects.toThrow(ServiceError);
	});

	it('free pull is available again after KST midnight', async () => {
		const { repos, userId } = await seeded();
		await pullCard({ repos, userId, rand: randN, clock: () => new Date('2026-08-23T05:00:00Z') });
		const next = await pullCard({
			repos,
			userId,
			rand: randN,
			clock: () => new Date('2026-08-23T15:00:00Z') // 00:00 KST Aug 24
		});
		expect(next.usedFreePull).toBe(true);
	});
});

describe('pull credits & inventory', () => {
	it('consumes a credit when the free pull is spent', async () => {
		const { repos, userId } = await seeded();
		const clock = () => new Date('2026-08-23T05:00:00Z');
		await pullCard({ repos, userId, rand: randN, clock });
		await repos.game.addPullCredits(userId, 2);

		const r1 = await pullCard({ repos, userId, rand: randN, clock });
		expect(r1.usedFreePull).toBe(false);
		expect(r1.creditsRemaining).toBe(1);

		const r2 = await pullCard({ repos, userId, rand: randN, clock });
		expect(r2.creditsRemaining).toBe(0);
		await expect(pullCard({ repos, userId, rand: randN, clock })).rejects.toThrow(/부족/);
	});

	it('adds to inventory and increments quantity on duplicates', async () => {
		const { repos, userId } = await seeded();
		const clock = () => new Date('2026-08-23T05:00:00Z');
		const first = await pullCard({ repos, userId, rand: randN, clock });
		expect(first.isNew).toBe(true);
		expect(first.quantity).toBe(1);

		// force the same card again by using the same deterministic rand
		const again = await pullCard({ repos, userId, rand: randN, clock: () => new Date('2026-08-24T05:00:00Z') });
		expect(again.card.id).toBe(first.card.id);
		expect(again.isNew).toBe(false);
		expect(again.quantity).toBe(2);

		const inv = await repos.game.getInventory(userId);
		expect(inv.find((i) => i.cardId === first.card.id)?.quantity).toBe(2);
	});

	it('exposes pull status', async () => {
		const { repos, userId } = await seeded();
		const clock = () => new Date('2026-08-23T05:00:00Z');
		expect(await getPullStatus(repos, userId, clock)).toEqual({ freeAvailable: true, credits: 0 });
		await pullCard({ repos, userId, rand: randN, clock });
		expect(await getPullStatus(repos, userId, clock)).toEqual({ freeAvailable: false, credits: 0 });
	});
});
