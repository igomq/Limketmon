import { fail, redirect } from '@sveltejs/kit';
import { getRepositories } from '$lib/server/repo.ts';
import { redeemCoupon } from '$lib/server/services/coupons.ts';
import { ServiceError } from '$lib/server/errors.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return {
		credits: (await getRepositories().game.getGameState(locals.user.id)).pullCredits
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const repos = getRepositories();
		const data = await request.formData();
		const code = String(data.get('code') ?? '');

		try {
			const { credits } = await redeemCoupon(repos, locals.user.id, code);
			return { success: true, credits, error: '' };
		} catch (e) {
			if (e instanceof ServiceError) {
				return fail(400, {
					error: e.message,
					credits: (await repos.game.getGameState(locals.user.id)).pullCredits
				});
			}
			throw e;
		}
	}
};
