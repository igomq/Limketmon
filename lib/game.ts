import 'server-only';
import { getDatabase } from '../db/index';
import manifest from './data/cards.curated.json';
import type { Card } from './cards';
import { kstDate, rollRarity, type Rarity } from './rules';
import { savePull } from './pull';

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
  const drawn = Array.from({ length: count }, () => pickCard(rollRarity(randomUnit())));
  try {
    const results = await savePull(db, userId, drawn, now);
    return { results, snapshot: await getSnapshot(userId, now) };
  } catch (error) {
    if (error instanceof Error && /chk_user_game_state_credits/.test(error.message)) {
      throw new GameError('not_enough_credits', count === 5
        ? '5장 뽑기에는 뽑기권 5장이 필요해요.'
        : '오늘의 무료 뽑기를 사용했고, 뽑기권이 부족해요.');
    }
    throw error;
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
