import { getMockDb, mockId } from './db.ts';
import type { AuthRepository, Session, User } from '../types.ts';

export class MockAuthRepository implements AuthRepository {
	async createUser(email: string, passwordHash: string, passwordSalt: string): Promise<User> {
		const db = getMockDb();
		const user: User = {
			id: mockId(db),
			email,
			passwordHash,
			passwordSalt,
			createdAt: new Date().toISOString()
		};
		db.users.set(user.id, user);
		db.usersByEmail.set(email, user.id);
		return user;
	}

	async findUserByEmail(email: string): Promise<User | null> {
		const db = getMockDb();
		const id = db.usersByEmail.get(email);
		return id ? (db.users.get(id) ?? null) : null;
	}

	async getUser(userId: string): Promise<User | null> {
		return getMockDb().users.get(userId) ?? null;
	}

	async createSession(userId: string, expiresAt: string): Promise<Session> {
		const db = getMockDb();
		const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
		const session: Session = { token, userId, expiresAt };
		db.sessions.set(token, session);
		return session;
	}

	async getSession(token: string): Promise<Session | null> {
		const session = getMockDb().sessions.get(token) ?? null;
		if (!session) return null;
		if (new Date(session.expiresAt).getTime() <= Date.now()) {
			db_delete(token);
			return null;
		}
		return session;
	}

	async deleteSession(token: string): Promise<void> {
		db_delete(token);
	}
}

function db_delete(token: string) {
	getMockDb().sessions.delete(token);
}
