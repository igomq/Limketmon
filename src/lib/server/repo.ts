import { env } from '$env/dynamic/private';
import { MockAuthRepository } from './repositories/mock/auth.ts';
import { MockGameRepository } from './repositories/mock/game.ts';
import type { Repositories } from './repositories/types.ts';

/**
 * Repository factory. The rest of the app only ever sees the `Repositories`
 * interfaces — swapping BACKEND_MODE to a real adapter is the only change
 * needed to move to ChatGPT Sites' persistent DB.
 */
export function getRepositories(): Repositories {
	const mode = env.BACKEND_MODE ?? 'mock';
	switch (mode) {
		case 'mock':
			return { auth: new MockAuthRepository(), game: new MockGameRepository() };
		case 'sites':
			// Not implemented yet — stub only. Do not fake a Sites API.
			throw new Error('BACKEND_MODE=sites is not implemented yet (see docs/SITES_HANDOFF.md)');
		default:
			throw new Error(`Unknown BACKEND_MODE: ${mode}`);
	}
}
