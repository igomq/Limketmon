import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, getUserFromSession } from '$lib/server/services/auth.ts';
import { getRepositories } from '$lib/server/repo.ts';

const PROTECTED = ['/pull', '/collection', '/coupon', '/api'];

export const handle: Handle = async ({ event, resolve }) => {
	const repos = getRepositories();
	event.locals.user = await getUserFromSession(
		repos,
		event.cookies.get(SESSION_COOKIE)
	);

	const path = event.url.pathname;
	if (!event.locals.user && PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		redirect(303, `/login?redirectTo=${encodeURIComponent(path)}`);
	}

	return resolve(event);
};
