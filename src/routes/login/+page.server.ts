import { fail, redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, createSession, login, sessionCookieOptions, signup } from '$lib/server/services/auth.ts';
import { ServiceError } from '$lib/server/errors.ts';
import { getRepositories } from '$lib/server/repo.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(303, '/');
	return { redirectTo: url.searchParams.get('redirectTo') ?? '/' };
};

export const actions: Actions = {
	login: async ({ request, cookies }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');
		const redirectTo = String(data.get('redirectTo') ?? '/') || '/';

		try {
			const user = await login(getRepositories(), email, password);
			const token = await createSession(getRepositories(), user.id);
			cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		} catch (e) {
			if (e instanceof ServiceError) {
				return fail(400, { error: e.message, email, redirectTo: '' });
			}
			throw e;
		}
		redirect(303, redirectTo.startsWith('/') ? redirectTo : '/');
	},

	guest: async ({ cookies }) => {
		const repos = getRepositories();
		const email = `guest-${crypto.randomUUID().slice(0, 8)}@guest.local`;
		const user = await signup(repos, email, crypto.randomUUID());
		const token = await createSession(repos, user.id);
		cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		redirect(303, '/');
	}
};
