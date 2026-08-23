import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepositories } from '$lib/server/repo.ts';
import { pullCard } from '$lib/server/services/pulls.ts';
import { ServiceError } from '$lib/server/errors.ts';
import { env } from '$env/dynamic/private';

function testRand() {
	if (env.E2E !== 'true') return undefined;
	const roll = Number(env.E2E_RAND ?? 0.1);
	const safeRoll = Number.isFinite(roll) && roll >= 0 && roll < 1 ? roll : 0.1;
	return () => safeRoll;
}

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthorized');
	try {
		const result = await pullCard({
			repos: getRepositories(),
			userId: locals.user.id,
			rand: testRand()
		});
		return json(result);
	} catch (e) {
		if (e instanceof ServiceError) {
			return json({ error: e.code, message: e.message }, { status: 409 });
		}
		throw e;
	}
};
