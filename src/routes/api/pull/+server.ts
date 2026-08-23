import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepositories } from '$lib/server/repo.ts';
import { pullCard } from '$lib/server/services/pulls.ts';
import { ServiceError } from '$lib/server/errors.ts';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthorized');
	try {
		const result = await pullCard({ repos: getRepositories(), userId: locals.user.id });
		return json(result);
	} catch (e) {
		if (e instanceof ServiceError) {
			return json({ error: e.code, message: e.message }, { status: 409 });
		}
		throw e;
	}
};
