import { RARITIES, type CardDefinition, type Rarity } from '$lib/cards.ts';
import { cardsOfRarity } from '$lib/server/cards-registry.ts';
import { ServiceError } from '$lib/server/errors.ts';
import { kstDateString, type Clock } from '$lib/server/kst.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';

export const PULL_WEIGHTS: Array<{ rarity: Rarity; weight: number }> = [
	{ rarity: 'N', weight: 0.5 },
	{ rarity: 'R', weight: 0.27 },
	{ rarity: 'SR', weight: 0.14 },
	{ rarity: 'SSR', weight: 0.07 },
	{ rarity: 'UR', weight: 0.02 }
];

/** Injectable randomness so tests are deterministic. */
export type Rand = () => number;
export const systemRand: Rand = Math.random;

export function rollRarity(roll: number, weights = PULL_WEIGHTS): Rarity {
	let acc = 0;
	for (const { rarity, weight } of weights) {
		acc += weight;
		if (roll < acc) return rarity;
	}
	return 'N';
}

function pickCard(rarity: Rarity, rand: Rand): CardDefinition {
	const idx = RARITIES.indexOf(rarity);
	// fallback: try lower rarities first, then higher, so a pull always succeeds
	for (const delta of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
		const r = RARITIES[idx + delta];
		if (!r) continue;
		const pool = cardsOfRarity(r);
		if (pool.length > 0) return pool[Math.floor(rand() * pool.length)]!;
	}
	throw new ServiceError('no_cards', '카드 manifest가 비어 있습니다. pnpm cards:sync를 실행하세요.');
}

export interface PullResult {
	card: CardDefinition;
	isNew: boolean;
	quantity: number;
	usedFreePull: boolean;
	creditsRemaining: number;
}

export interface PullDeps {
	userId: string;
	repos: Repositories;
	rand?: Rand;
	clock?: Clock;
}

export async function getPullStatus(
	repos: Repositories,
	userId: string,
	clock: Clock
): Promise<{ freeAvailable: boolean; credits: number }> {
	const state = await repos.game.getGameState(userId);
	const today = kstDateString(clock);
	return { freeAvailable: state.lastFreePullDate !== today, credits: state.pullCredits };
}

/**
 * Server-side pull: daily free pull (KST calendar date) first, then credits.
 * Never trust the client about either.
 */
export async function pullCard(deps: PullDeps): Promise<PullResult> {
	const { repos, userId } = deps;
	const rand = deps.rand ?? systemRand;
	const clock = deps.clock ?? (() => new Date());

	const { freeAvailable } = await getPullStatus(repos, userId, clock);

	let usedFreePull = false;
	if (freeAvailable) {
		await repos.game.setLastFreePullDate(userId, kstDateString(clock));
		usedFreePull = true;
	} else {
		const consumed = await repos.game.consumePullCredit(userId);
		if (!consumed) {
			throw new ServiceError('no_credits', '오늘의 무료 뽑기를 이미 사용했고, 뽑기권이 부족합니다.');
		}
	}

	const card = pickCard(rollRarity(rand()), rand);
	const now = clock().toISOString();
	const { isNew, quantity } = await repos.game.addCardToInventory(userId, card.id, now);
	await repos.game.recordPull(userId, card.id, card.rarity, now);
	const { credits } = await getPullStatus(repos, userId, clock);

	return { card, isNew, quantity, usedFreePull, creditsRemaining: credits };
}
