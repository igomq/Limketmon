import { describe, expect, it, beforeEach } from 'vitest';
import { resetMockDb } from '$lib/server/repositories/mock/db.ts';
import { MockAuthRepository } from '$lib/server/repositories/mock/auth.ts';
import { MockGameRepository } from '$lib/server/repositories/mock/game.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';
import { redeemCoupon } from '$lib/server/services/coupons.ts';
import { signup } from '$lib/server/services/auth.ts';

function makeRepos(): Repositories {
	return { auth: new MockAuthRepository(), game: new MockGameRepository() };
}

beforeEach(() => resetMockDb());

describe('coupon', () => {
	it('redeems LIMKETMON for +100 credits (case/space-insensitive)', async () => {
		const repos = makeRepos();
		const u = await signup(repos, 'a@b.com', 'password123');
		const res = await redeemCoupon(repos, u.id, '  limketmon ');
		expect(res.credits).toBe(100);
		expect((await repos.game.getGameState(u.id)).pullCredits).toBe(100);
	});

	it('rejects a second redemption on the same account', async () => {
		const repos = makeRepos();
		const u = await signup(repos, 'a@b.com', 'password123');
		await redeemCoupon(repos, u.id, 'LIMKETMON');
		await expect(redeemCoupon(repos, u.id, 'LIMKETMON')).rejects.toThrow(/이미 사용한/);
		// no double payout
		expect((await repos.game.getGameState(u.id)).pullCredits).toBe(100);
	});

	it('works on a different account', async () => {
		const repos = makeRepos();
		const a = await signup(repos, 'a@b.com', 'password123');
		const b = await signup(repos, 'b@b.com', 'password123');
		await redeemCoupon(repos, a.id, 'LIMKETMON');
		await expect(redeemCoupon(repos, b.id, 'LIMKETMON')).resolves.toBeTruthy();
	});

	it('rejects an invalid code', async () => {
		const repos = makeRepos();
		const u = await signup(repos, 'a@b.com', 'password123');
		await expect(redeemCoupon(repos, u.id, 'NOT_A_COUPON')).rejects.toThrow(/유효하지 않은/);
	});
});
