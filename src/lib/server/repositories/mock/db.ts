/**
 * In-memory mock database. Kept on globalThis so Vite dev hot-reloads
 * preserve state. Wiped on server restart — acceptable for local dev.
 * Shape mirrors the production domain schema (see docs/SITES_HANDOFF.md).
 */
import type { InventoryItem, } from '$lib/cards.ts';
import type { PullHistoryEntry, Session, User, UserGameState } from '../types.ts';

export interface MockDb {
	users: Map<string, User>;
	usersByEmail: Map<string, string>; // email -> userId
	sessions: Map<string, Session>;
	inventories: Map<string, Map<string, InventoryItem>>; // userId -> cardId -> item
	gameStates: Map<string, UserGameState>;
	couponRedemptions: Map<string, Set<string>>; // userId -> redeemed codes
	pullHistory: PullHistoryEntry[];
	nextId: number;
}

const KEY = Symbol.for('limketmon.mockDb');

export function getMockDb(): MockDb {
	const g = globalThis as Record<symbol, MockDb | undefined>;
	if (!g[KEY]) {
		g[KEY] = {
			users: new Map(),
			usersByEmail: new Map(),
			sessions: new Map(),
			inventories: new Map(),
			gameStates: new Map(),
			couponRedemptions: new Map(),
			pullHistory: [],
			nextId: 1
		};
	}
	return g[KEY]!;
}

export function resetMockDb(): void {
	const g = globalThis as Record<symbol, MockDb | undefined>;
	delete g[KEY];
}

export function mockId(db: MockDb): string {
	return `mock-${db.nextId++}`;
}
