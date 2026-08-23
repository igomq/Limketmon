import { redirect } from '@sveltejs/kit';
import { getRepositories } from '$lib/server/repo.ts';
import { getCollection } from '$lib/server/services/collection.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return { entries: await getCollection(getRepositories(), locals.user.id) };
};
