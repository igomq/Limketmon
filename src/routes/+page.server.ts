import { redirect } from '@sveltejs/kit';
import { getRepositories } from '$lib/server/repo.ts';
import { getCollection } from '$lib/server/services/collection.ts';
import { getPullStatus } from '$lib/server/services/pulls.ts';
import { systemClock } from '$lib/server/kst.ts';
import { SESSION_COOKIE } from '$lib/server/services/auth.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	const repos = getRepositories();
	const [{ freeAvailable, credits }, collection] = await Promise.all([
		getPullStatus(repos, locals.user.id, systemClock),
		getCollection(repos, locals.user.id)
	]);
	const owned = collection.filter((e) => e.quantity !== null).length;
	return {
		freeAvailable,
		credits,
		ownedCount: owned,
		totalCount: collection.length,
		completion: collection.length === 0 ? 0 : Math.round((owned / collection.length) * 100)
	};
};

export const actions: Actions = {
	logout: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE);
		if (token) {
			await getRepositories().auth.deleteSession(token);
			cookies.delete(SESSION_COOKIE, { path: '/' });
		}
		redirect(303, '/login');
	}
};
