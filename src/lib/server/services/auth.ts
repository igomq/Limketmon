import { hashPassword, verifyPassword } from '$lib/server/crypto.ts';
import { ServiceError } from '$lib/server/errors.ts';
import type { Repositories, User } from '$lib/server/repositories/types.ts';

export const SESSION_COOKIE = 'limketmon_session';
const SESSION_TTL_DAYS = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function signup(repos: Repositories, emailRaw: string, password: string): Promise<User> {
	const email = normalizeEmail(emailRaw);
	if (!EMAIL_RE.test(email)) throw new ServiceError('invalid_email', '올바른 이메일 형식이 아닙니다.');
	if (password.length < 6)
		throw new ServiceError('weak_password', '비밀번호는 6자 이상이어야 합니다.');
	if (await repos.auth.findUserByEmail(email))
		throw new ServiceError('email_taken', '이미 가입된 이메일입니다.');

	const { hash, salt } = await hashPassword(password);
	return repos.auth.createUser(email, hash, salt);
}

export async function login(repos: Repositories, emailRaw: string, password: string): Promise<User> {
	const email = normalizeEmail(emailRaw);
	const user = await repos.auth.findUserByEmail(email);
	if (!user) throw new ServiceError('bad_credentials', '이메일 또는 비밀번호가 틀렸습니다.');
	const ok = await verifyPassword(password, user.passwordHash, user.passwordSalt);
	if (!ok) throw new ServiceError('bad_credentials', '이메일 또는 비밀번호가 틀렸습니다.');
	return user;
}

export async function createSession(repos: Repositories, userId: string): Promise<string> {
	const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
	const session = await repos.auth.createSession(userId, expiresAt);
	return session.token;
}

export async function getUserFromSession(
	repos: Repositories,
	token: string | undefined
): Promise<User | null> {
	if (!token) return null;
	const session = await repos.auth.getSession(token);
	if (!session) return null;
	return (await repos.auth.getUser(session.userId)) ?? null;
}

export function sessionCookieOptions(maxAgeSeconds: number = SESSION_TTL_DAYS * 86400) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: false, // flip to true behind HTTPS on Sites
		maxAge: maxAgeSeconds
	};
}
