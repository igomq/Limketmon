import type { InventoryItem } from '$lib/cards.ts';

export interface User {
	id: string;
	email: string;
	passwordHash: string;
	passwordSalt: string;
	createdAt: string;
}

export interface Session {
	token: string;
	userId: string;
	expiresAt: string;
}

export interface UserGameState {
	pullCredits: number;
	lastFreePullDate: string | null;
}

export interface PullHistoryEntry {
	id: string;
	userId: string;
	cardId: string;
	rarity: string;
	pulledAt: string;
}

export interface AuthRepository {
	createUser(email: string, passwordHash: string, passwordSalt: string): Promise<User>;
	findUserByEmail(email: string): Promise<User | null>;
	getUser(userId: string): Promise<User | null>;
	createSession(userId: string, expiresAt: string): Promise<Session>;
	getSession(token: string): Promise<Session | null>;
	deleteSession(token: string): Promise<void>;
}

export interface GameRepository {
	getGameState(userId: string): Promise<UserGameState>;
	addPullCredits(userId: string, amount: number): Promise<void>;
	/** Atomically decrement one credit; returns false when none remain. */
	consumePullCredit(userId: string): Promise<boolean>;
	setLastFreePullDate(userId: string, date: string): Promise<void>;
	getInventory(userId: string): Promise<InventoryItem[]>;
	addCardToInventory(userId: string, cardId: string, now: string): Promise<{ isNew: boolean; quantity: number }>;
	hasRedeemedCoupon(userId: string, code: string): Promise<boolean>;
	redeemCoupon(userId: string, code: string, credits: number, now: string): Promise<void>;
	recordPull(userId: string, cardId: string, rarity: string, now: string): Promise<void>;
}

export interface Repositories {
	auth: AuthRepository;
	game: GameRepository;
}
