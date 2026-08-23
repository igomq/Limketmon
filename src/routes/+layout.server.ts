import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => ({
	user: locals.user ? { id: locals.user.id, email: locals.user.email } : null
});
