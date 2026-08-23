import { redirect } from '@sveltejs/kit';
import { getRepositories } from '$lib/server/repo.ts';
import { getPullStatus } from '$lib/server/services/pulls.ts';
import { systemClock } from '$lib/server/kst.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return await getPullStatus(getRepositories(), locals.user.id, systemClock);
};
