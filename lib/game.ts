import 'server-only';
import { getDatabase } from '../db/index';
import manifest from './data/cards.generated.json';
import type { Card } from './cards';
import { kstDate, rollRarity, type Rarity } from './rules';

export type { Card } from './cards';

export interface Snapshot {
  freeAvailable: boolean;
  credits: number;
  completion: number;
  inventory: Array<{ cardId: string; quantity: number; firstObtainedAt: string }>;
}

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const cards = manifest.cards as Card[];

export interface PullResult {
  card: Card;
  isNew: boolean;
  quantity: number;
  usedFreePull: boolean;
}

export async function ensureUser(userId: string, email: string): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO users (id, email, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
    `).bind(userId, email, now, now),
    db.prepare(`
      INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date)
      VALUES (?, 0, NULL)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(userId)
  ]);
}

export async function getSnapshot(userId: string, now = new Date()): Promise<Snapshot> {
  const db = getDatabase();
  const [stateResult, inventoryResult] = await db.batch([
    db.prepare('SELECT pull_credits, last_free_pull_date FROM user_game_state WHERE user_id = ?').bind(userId),
    db.prepare(`
      SELECT card_id, quantity, first_obtained_at
      FROM inventory WHERE user_id = ? ORDER BY card_id
    `).bind(userId)
  ]);
  const state = stateResult.results[0] as
    | { pull_credits: number; last_free_pull_date: string | null }
    | undefined;
  const inventory = inventoryResult.results as Array<{
    card_id: string;
    quantity: number;
    first_obtained_at: string;
  }>;
  const owned = inventory.length;

  return {
    freeAvailable: state?.last_free_pull_date !== kstDate(now),
    credits: state?.pull_credits ?? 0,
    completion: Math.round((owned / cards.length) * 100),
    inventory: inventory.map((item) => ({
      cardId: item.card_id,
      quantity: item.quantity,
      firstObtainedAt: item.first_obtained_at
    }))
  };
}

export async function pullCards(userId: string, count: 1 | 5): Promise<{
  results: PullResult[];
  snapshot: Snapshot;
}> {
  const db = getDatabase();
  const now = new Date();
  const today = kstDate(now);
  const usedFreePull = count === 1 && await claimSinglePull(db, userId, today);
  if (count === 5) await claimFivePulls(db, userId);

  const drawn = Array.from({ length: count }, () => pickCard(rollRarity(randomUnit())));
  const pulledAt = now.toISOString();
  const writes = drawn.flatMap((card) => [
    db.prepare(`
        INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1
        RETURNING quantity
      `).bind(userId, card.id, pulledAt),
    db.prepare(`
        INSERT INTO pull_history (id, user_id, card_id, rarity, pulled_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), userId, card.id, card.rarity, pulledAt)
  ]);
  const writeResults = await db.batch(writes);

  return {
    results: drawn.map((card, index) => {
      const quantity = Number((writeResults[index * 2]!.results[0] as { quantity: number }).quantity);
      return { card, isNew: quantity === 1, quantity, usedFreePull };
    }),
    snapshot: await getSnapshot(userId, now)
  };
}

async function claimSinglePull(db: D1Database, userId: string, today: string): Promise<boolean> {
  const freeClaim = await db.prepare(`
    UPDATE user_game_state SET last_free_pull_date = ?
    WHERE user_id = ? AND (last_free_pull_date IS NULL OR last_free_pull_date != ?)
  `).bind(today, userId, today).run();
  if ((freeClaim.meta.changes ?? 0) > 0) return true;

  const creditClaim = await db.prepare(`
    UPDATE user_game_state SET pull_credits = pull_credits - 1
    WHERE user_id = ? AND pull_credits > 0
  `).bind(userId).run();
  if ((creditClaim.meta.changes ?? 0) === 0) {
    throw new GameError('no_credits', '오늘의 무료 뽑기를 이미 사용했고, 뽑기권이 부족합니다.');
  }
  return false;
}

async function claimFivePulls(db: D1Database, userId: string): Promise<void> {
  const claim = await db.prepare(`
    UPDATE user_game_state SET pull_credits = pull_credits - 5
    WHERE user_id = ? AND pull_credits >= 5
  `).bind(userId).run();
  if ((claim.meta.changes ?? 0) === 0) {
    throw new GameError('not_enough_credits', '5연속 뽑기에는 뽑기권 5개가 필요합니다.');
  }
}

export async function redeemCoupon(userId: string, rawCode: string): Promise<Snapshot> {
  const code = rawCode.trim().toUpperCase();
  if (code !== 'LIMKETMON') throw new GameError('invalid_code', '유효하지 않은 쿠폰 코드입니다.');

  const db = getDatabase();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO coupon_redemptions (user_id, coupon_code, redeemed_at)
        VALUES (?, ?, ?)
      `).bind(userId, code, new Date().toISOString()),
      db.prepare(`
        UPDATE user_game_state SET pull_credits = pull_credits + 100 WHERE user_id = ?
      `).bind(userId)
    ]);
  } catch (error) {
    const redeemed = await db.prepare(`
      SELECT 1 FROM coupon_redemptions WHERE user_id = ? AND coupon_code = ?
    `).bind(userId, code).first();
    if (redeemed) throw new GameError('already_redeemed', '이미 사용한 쿠폰입니다.');
    throw error;
  }

  return getSnapshot(userId);
}

function randomUnit(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! / 2 ** 32;
}

function pickCard(rarity: Rarity): Card {
  const rarities: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR'];
  const start = rarities.indexOf(rarity);
  for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    const candidate = rarities[start + offset];
    if (!candidate) continue;
    const pool = cards.filter((card) => card.rarity === candidate);
    if (pool.length) return pool[Math.floor(randomUnit() * pool.length)]!;
  }
  throw new GameError('no_cards', '카드 데이터가 비어 있습니다.');
}
