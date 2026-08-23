import { describe, expect, it, beforeEach } from 'vitest';
import { resetMockDb } from '$lib/server/repositories/mock/db.ts';
import { MockAuthRepository } from '$lib/server/repositories/mock/auth.ts';
import { MockGameRepository } from '$lib/server/repositories/mock/game.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';
import { createSession, login, signup, getUserFromSession } from '$lib/server/services/auth.ts';

function makeRepos(): Repositories {
	return { auth: new MockAuthRepository(), game: new MockGameRepository() };
}

beforeEach(() => resetMockDb());

describe('auth', () => {
	it('signs up a new user', async () => {
		const repos = makeRepos();
		const user = await signup(repos, '  A@B.COM ', 'password123');
		expect(user.email).toBe('a@b.com');
		expect(user.passwordHash).not.toBe('password123');
		expect(await repos.auth.findUserByEmail('a@b.com')).toBeTruthy();
	});

	it('rejects duplicate email', async () => {
		const repos = makeRepos();
		await signup(repos, 'a@b.com', 'password123');
		await expect(signup(repos, 'a@b.com', 'other123')).rejects.toThrow(/이미 가입된/);
	});

	it('rejects weak password and bad email', async () => {
		const repos = makeRepos();
		await expect(signup(repos, 'a@b.com', '123')).rejects.toThrow(/비밀번호/);
		await expect(signup(repos, 'not-an-email', 'password123')).rejects.toThrow(/이메일/);
	});

	it('logs in with correct password and fails with wrong one', async () => {
		const repos = makeRepos();
		await signup(repos, 'a@b.com', 'password123');
		await expect(login(repos, 'a@b.com', 'password123')).resolves.toBeTruthy();
		await expect(login(repos, 'a@b.com', 'wrong-pass')).rejects.toThrow(/틀렸습니다/);
		await expect(login(repos, 'nobody@x.io', 'password123')).rejects.toThrow(/틀렸습니다/);
	});

	it('creates, reads and deletes sessions', async () => {
		const repos = makeRepos();
		const user = await signup(repos, 'a@b.com', 'password123');
		const token = await createSession(repos, user.id);
		expect(await getUserFromSession(repos, token)).toBeTruthy();
		await repos.auth.deleteSession(token);
		expect(await getUserFromSession(repos, token)).toBeNull();
	});
});
