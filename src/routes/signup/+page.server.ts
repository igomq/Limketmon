import { fail, redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, createSession, sessionCookieOptions, signup } from '$lib/server/services/auth.ts';
import { ServiceError } from '$lib/server/errors.ts';
import { getRepositories } from '$lib/server/repo.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');

		try {
			const user = await signup(getRepositories(), email, password);
			const token = await createSession(getRepositories(), user.id);
			cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		} catch (e) {
			if (e instanceof ServiceError) return fail(400, { error: e.message, email });
			throw e;
		}
		redirect(303, '/');
	}
};
