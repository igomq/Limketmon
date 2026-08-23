import { beforeEach, describe, expect, it } from 'vitest';
import { getAllCards } from '$lib/server/cards-registry.ts';
import { getCollection } from '$lib/server/services/collection.ts';
import { resetMockDb } from '$lib/server/repositories/mock/db.ts';
import { MockAuthRepository } from '$lib/server/repositories/mock/auth.ts';
import { MockGameRepository } from '$lib/server/repositories/mock/game.ts';
import { signup } from '$lib/server/services/auth.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';

const makeRepos = (): Repositories => ({
	auth: new MockAuthRepository(),
	game: new MockGameRepository()
});

beforeEach(() => resetMockDb());

describe('collection', () => {
	it('joins the manifest with inventory, quantity and acquisition time', async () => {
		const repos = makeRepos();
		const user = await signup(repos, 'collector@test.io', 'password123');
		const card = getAllCards()[0]!;
		const obtainedAt = '2026-08-23T05:00:00.000Z';

		await repos.game.addCardToInventory(user.id, card.id, obtainedAt);
		await repos.game.addCardToInventory(user.id, card.id, '2026-08-23T06:00:00.000Z');

		const collection = await getCollection(repos, user.id);
		expect(collection).toHaveLength(getAllCards().length);
		expect(collection.find((entry) => entry.card.id === card.id)).toMatchObject({
			quantity: 2,
			firstObtainedAt: obtainedAt
		});
		expect(collection.filter((entry) => entry.quantity !== null)).toHaveLength(1);
	});
});
