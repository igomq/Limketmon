import type { InventoryItem } from '$lib/cards.ts';
import { getMockDb, mockId } from './db.ts';
import type { GameRepository, UserGameState } from '../types.ts';

export class MockGameRepository implements GameRepository {
	async getGameState(userId: string): Promise<UserGameState> {
		const db = getMockDb();
		let state = db.gameStates.get(userId);
		if (!state) {
			state = { pullCredits: 0, lastFreePullDate: null };
			db.gameStates.set(userId, state);
		}
		return state;
	}

	async addPullCredits(userId: string, amount: number): Promise<void> {
		const state = await this.getGameState(userId);
		state.pullCredits += amount;
	}

	async consumePullCredit(userId: string): Promise<boolean> {
		const state = await this.getGameState(userId);
		if (state.pullCredits <= 0) return false;
		state.pullCredits -= 1;
		return true;
	}

	async setLastFreePullDate(userId: string, date: string): Promise<void> {
		const state = await this.getGameState(userId);
		state.lastFreePullDate = date;
	}

	async getInventory(userId: string): Promise<InventoryItem[]> {
		const db = getMockDb();
		let inv = db.inventories.get(userId);
		if (!inv) {
			inv = new Map();
			db.inventories.set(userId, inv);
		}
		return [...inv.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
	}

	async addCardToInventory(
		userId: string,
		cardId: string,
		now: string
	): Promise<{ isNew: boolean; quantity: number }> {
		const db = getMockDb();
		let inv = db.inventories.get(userId);
		if (!inv) {
			inv = new Map();
			db.inventories.set(userId, inv);
		}
		const existing = inv.get(cardId);
		if (existing) {
			existing.quantity += 1;
			return { isNew: false, quantity: existing.quantity };
		}
		const item: InventoryItem = { cardId, quantity: 1, firstObtainedAt: now };
		inv.set(cardId, item);
		return { isNew: true, quantity: 1 };
	}

	async hasRedeemedCoupon(userId: string, code: string): Promise<boolean> {
		return getMockDb().couponRedemptions.get(userId)?.has(code) ?? false;
	}

	async redeemCoupon(userId: string, code: string, credits: number, _now: string): Promise<void> {
		const db = getMockDb();
		let redeemed = db.couponRedemptions.get(userId);
		if (!redeemed) {
			redeemed = new Set();
			db.couponRedemptions.set(userId, redeemed);
		}
		redeemed.add(code);
		await this.addPullCredits(userId, credits);
	}

	async recordPull(userId: string, cardId: string, rarity: string, now: string): Promise<void> {
		const db = getMockDb();
		db.pullHistory.push({ id: mockId(db), userId, cardId, rarity, pulledAt: now });
	}
}
