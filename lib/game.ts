import 'server-only';
import { env } from 'cloudflare:workers';
import { getDatabase } from '../db/index';
import manifest from './data/cards.curated.json';
import type { Card } from './cards';
import { effectiveCard, parseTraits, type CardProgress, type Trait } from './progression';
import { kstDate, RARITY_ORDER, rollGuaranteedRarity, rollRarity, type Rarity } from './rules';
import { InsufficientTickets, savePull, type TicketType } from './pull';
import { DECK_SIZE, MAX_DECKS, normalizeDeckName, validateDeck } from './decks';
import { dailyChallenge, dailyClaimKey, type DailyChallenge } from './daily';
import { ACHIEVEMENTS, achievementById, achievementClaimKey, evaluateAchievements, type AchievementProgress } from './achievements';
import { planBattleRewards, pveFirstClearClaimKey, victoryTicketReward } from './rewards';
import { summarizeBattles, type BattleRow } from './stats';
import { buildSetup, CARD_BY_ID } from './battle/setup';
import { battleStats } from './battle/stats';
import { applyEnhance, clampEnhance, enhanceCost, enhanceMaterials, MAX_ENHANCE, parseDeckSlots } from './enhance';
import { BATTLE_MODES, BATTLE_RULESET_VERSION, type BattleEvent, type BattleMode, type BattleModifier, type BattleState, type Decision } from './battle/types';
import { MODE_LABELS, OPPONENTS, opponentById } from './battle/opponents';
import { aiDecision } from './battle/ai';
import { runBattle } from './battle/simulate';
import type { BattleResultSummary, BattleSetupResponse, BattleSummaryRow, DailyChallengeSummary, DeckSummary, RewardLine, StatsSummary } from './battle/api';

export type { Card } from './cards';

export interface Snapshot {
  freeAvailable: boolean;
  credits: number;
  completion: number;
  inventory: Array<{ cardId: string; quantity: number; materialCount: number; firstObtainedAt: string; enhanceLevel: number; baseCardId: string; rarity: Rarity; traits: Trait[]; card: Card }>;
  tickets: { low: number; sr: number; ssr: number };
  materials: { proof: number; fragments: number; twinProof: number };
  /** Battle modes the account has unlocked. 'normal' is always present. */
  unlockedModes: BattleMode[];
  /** Opponent ids first-cleared per mode; the UI shows progress and completion from this. */
  clearedByMode: Record<BattleMode, string[]>;
  decks: DeckSummary[];
  daily: DailyChallengeSummary;
  stats: StatsSummary;
  /** Most recent settled battles, newest first; the record screen replays these. */
  recentBattles: BattleSummaryRow[];
  /** Opponent ids already cleared at least once; the UI uses this for first-clear labels. */
  clearedOpponents: string[];
  opponents: Array<{
    id: string;
    name: string;
    title: string;
    difficulty: string;
    blurb: string;
    reward: number;
  }>;
}

export class GameError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const cards = manifest.cards as Card[];

export interface PullResult {
  card: Card;
  isNew: boolean;
  quantity: number;
  usedFreePull: boolean;
}

/** Snapshot for visitors who are not signed in; the UI must never have to guard for nulls. */
export function emptySnapshot(now = new Date()): Snapshot {
  const date = kstDate(now);
  return {
    freeAvailable: false,
    credits: 0,
    completion: 0,
    inventory: [],
    tickets: { low: 0, sr: 0, ssr: 0 },
    materials: { proof: 0, fragments: 0, twinProof: 0 },
    unlockedModes: ['normal'],
    clearedByMode: { normal: [], hard: [], chaos: [] },
    decks: [],
    daily: dailySummary(date, new Set()),
    recentBattles: [],
    clearedOpponents: [],
    opponents: OPPONENTS.map((opponent) => ({
      id: opponent.id,
      name: opponent.name,
      title: opponent.title,
      difficulty: opponent.difficulty,
      blurb: opponent.blurb,
      reward: opponent.reward.credits
    })),
    stats: {
      battles: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      streak: 0,
      bestStreak: 0,
      totalPulls: 0,
      pullsByRarity: {},
      topCards: [],
      rarityUsage: {},
      bossClears: 0,
      dailyClears: 0,
      satisfied: [],
      achievements: ACHIEVEMENTS.map((achievement) => ({
        id: achievement.id,
        name: achievement.name,
        description: achievement.description,
        reward: achievement.reward,
        unlockedAt: null
      }))
    }
  };
}

export async function ensureUser(userId: string, email: string): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO users (id, email, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
      WHERE users.email != excluded.email
    `).bind(userId, email, now, now),
    db.prepare(`
      INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, sr_tickets, ssr_tickets)
      VALUES (?, 0, NULL, 0, 0)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(userId)
  ]);
}

export async function getSnapshot(userId: string, now = new Date()): Promise<Snapshot> {
  const db = getDatabase();
  const date = kstDate(now);
  // Progress only ever depends on a bounded set of claim keys. Reading the whole reward_claims
  // table grew with every settled battle (settle:<id> and ticket_drop:<id> rows).
  const claimKeys = progressClaimKeys(date);
  const [stateResult, inventoryResult, deckResult, claimResult, battleResult, achievementResult, pullResult] = await db.batch([
    db.prepare('SELECT pull_credits, last_free_pull_date, low_tickets, proof, fragments, twin_proof, sr_tickets, ssr_tickets FROM user_game_state WHERE user_id = ?').bind(userId),
    db.prepare(`
      SELECT card_id, quantity, first_obtained_at, enhance_level, base_card_id, rarity_override, traits
      FROM inventory WHERE user_id = ? ORDER BY card_id
    `).bind(userId),
    db.prepare(`
      SELECT d.id, d.name, d.is_default, c.card_id, c.slot
      FROM decks d LEFT JOIN deck_cards c ON c.deck_id = d.id
      WHERE d.user_id = ? ORDER BY d.created_at ASC, c.slot ASC
    `).bind(userId),
    db.prepare(`SELECT claim_key FROM reward_claims WHERE user_id = ? AND claim_key IN (${claimKeys.map(() => '?').join(', ')})`).bind(userId, ...claimKeys),
    db.prepare(`
      SELECT id, result, kind, opponent_id, kst_date, created_at, deck_cards, mvp_card_id, damage_dealt, rounds, clutch
      FROM battles WHERE user_id = ? AND result != 'pending'
      ORDER BY created_at DESC LIMIT 200
    `).bind(userId),
    db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').bind(userId),
    db.prepare('SELECT rarity, COUNT(*) AS total FROM pull_history WHERE user_id = ? GROUP BY rarity').bind(userId)
  ]);
  const state = stateResult.results[0] as
    | { pull_credits: number; last_free_pull_date: string | null; low_tickets: number; proof: number; fragments: number; twin_proof: number; sr_tickets: number; ssr_tickets: number }
    | undefined;
  const inventory = inventoryResult.results as unknown as OwnedRow[];
  const materialPools = new Map<string, number>();
  for (const row of inventory) {
    const baseId = row.base_card_id ?? row.card_id;
    materialPools.set(baseId, (materialPools.get(baseId) ?? 0) + enhanceMaterials(row.quantity));
  }
  const owned = new Set(inventory.map((row) => row.base_card_id ?? row.card_id)).size;
  const claims = new Set((claimResult.results as Array<{ claim_key: string }>).map((row) => row.claim_key));
  const unlocked = new Map(
    (achievementResult.results as Array<{ achievement_id: string; unlocked_at: string }>).map((row) => [
      row.achievement_id,
      row.unlocked_at
    ])
  );
  const pullsByRarity: Record<string, number> = {};
  let totalPulls = 0;
  for (const row of pullResult.results as Array<{ rarity: string; total: number }>) {
    pullsByRarity[row.rarity] = Number(row.total);
    totalPulls += Number(row.total);
  }
  const rarityById: Record<string, string> = {};
  for (const card of cards) rarityById[card.id] = card.rarity;
  for (const row of inventory) rarityById[row.card_id] = progressOf(row).rarity;
  const rarityUsage: Record<string, number> = {};
  for (const battle of battleResult.results as Array<{ deck_cards: string }>) {
    for (const slot of parseDeckSlots(battle.deck_cards)) {
      const rarity = slot.progress?.rarity ?? rarityById[slot.id];
      if (rarity) rarityUsage[rarity] = (rarityUsage[rarity] ?? 0) + 1;
    }
  }
  const decks = toDecks(deckResult.results);
  const starter = decks.length === 0 && owned >= DECK_SIZE;
  if (starter) await createStarterDeck(userId, inventory);
  const rows: BattleRow[] = (battleResult.results as Array<Record<string, unknown>>).map((row) => ({
    result: String(row.result),
    kind: String(row.kind),
    opponentId: String(row.opponent_id),
    kstDate: String(row.kst_date),
    createdAt: String(row.created_at),
    deckCards: safeCards(row.deck_cards),
    mvpCardId: row.mvp_card_id === null ? null : String(row.mvp_card_id),
    clutch: Number(row.clutch ?? 0) === 1,
    damageDealt: Number(row.damage_dealt ?? 0)
  }));
  const base = summarizeBattles(rows, rarityById);
  // Counters come from SQL; the row window only feeds the streak, top cards and rarity mix.
  const counters = await battleCounters(userId);
  const progress: AchievementProgress = {
    wins: counters.wins,
    losses: counters.losses,
    bossClears: counters.bossClears,
    dailyClears: counters.dailyClears,
    nOnlyWins: counters.nOnlyWins,
    clutchWins: counters.clutchWins,
    totalPulls,
    ownedRarities: [...new Set(inventory.map((row) => rarityById[row.card_id]).filter(Boolean))]
  };
  const satisfied = new Set(evaluateAchievements(progress));
  const clearedByMode: Record<BattleMode, string[]> = { normal: [], hard: [], chaos: [] };
  for (const mode of BATTLE_MODES) {
    clearedByMode[mode] = OPPONENTS.filter((opponent) => claims.has(pveFirstClearClaimKey(opponent.id, mode))).map(
      (opponent) => opponent.id
    );
  }
  const unlockedModes = unlockedModesFrom(clearedByMode);

  return {
    freeAvailable: state?.last_free_pull_date !== kstDate(now),
    credits: state?.pull_credits ?? 0,
    completion: Math.round((owned / cards.length) * 100),
    materials: { proof: Number(state?.proof ?? 0), fragments: Number(state?.fragments ?? 0), twinProof: Number(state?.twin_proof ?? 0) },
    tickets: { low: Number(state?.low_tickets ?? 0), sr: Number(state?.sr_tickets ?? 0), ssr: Number(state?.ssr_tickets ?? 0) },
    unlockedModes,
    clearedByMode,
    decks: starter ? await listDecks(userId) : decks,
    daily: dailySummary(date, claims),
    recentBattles: recentBattles(battleResult.results),
    clearedOpponents: OPPONENTS.filter((opponent) => claims.has(pveFirstClearClaimKey(opponent.id))).map((opponent) => opponent.id),
    opponents: OPPONENTS.map((opponent) => ({
      id: opponent.id,
      name: opponent.name,
      title: opponent.title,
      difficulty: opponent.difficulty,
      blurb: opponent.blurb,
      reward: opponent.reward.credits
    })),
    stats: {
      ...base,
      rarityUsage,
      battles: counters.battles,
      wins: counters.wins,
      losses: counters.losses,
      winRate: counters.battles ? Math.round((counters.wins / counters.battles) * 1000) / 10 : 0,
      bossClears: counters.bossClears,
      dailyClears: counters.dailyClears,
      totalPulls,
      pullsByRarity,
      achievements: ACHIEVEMENTS.map((achievement) => ({
        id: achievement.id,
        name: achievement.name,
        description: achievement.description,
        reward: achievement.reward,
        unlockedAt: unlocked.get(achievement.id) ?? null
      })),
      satisfied: [...satisfied]
    },
    inventory: inventory.map((item) => ({
      cardId: item.card_id,
      quantity: item.quantity,
      materialCount: materialPools.get(item.base_card_id ?? item.card_id) ?? 0,
      firstObtainedAt: item.first_obtained_at,
      ...progressOf(item),
      card: ownedCard(item)
    }))
  };
}

/** Newest settled battles, for the record screen's replay list. */
function recentBattles(rows: unknown): BattleSummaryRow[] {
  return (rows as Array<Record<string, unknown>>).slice(0, 20).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    opponentId: String(row.opponent_id),
    opponentName: opponentById(String(row.opponent_id))?.name ?? String(row.opponent_id),
    result: String(row.result),
    rounds: Number(row.rounds ?? 0),
    damageDealt: Number(row.damage_dealt ?? 0),
    mvpCardId: row.mvp_card_id === null || row.mvp_card_id === undefined ? null : String(row.mvp_card_id),
    kstDate: String(row.kst_date),
    createdAt: String(row.created_at)
  }));
}

function safeCards(raw: unknown): string[] {
  return parseDeckSlots(raw).map((slot) => slot.id);
}


export async function pullCards(userId: string, count: 1 | 5 | 10 = 1, ticketType: TicketType = 'normal'): Promise<{
  results: PullResult[];
  snapshot: Snapshot;
}> {
  const db = getDatabase();
  const now = new Date();
  const drawn = Array.from({ length: count }, () => {
    const unit = randomUnit();
    const rarity = ticketType === 'low'
      ? (unit < 0.78 ? 'N' : unit < 0.98 ? 'R' : unit < 0.999 ? 'SR' : 'SSR')
      : ticketType === 'normal' ? rollRarity(unit) : rollGuaranteedRarity(unit, ticketType === 'ssr' ? 'SSR' : 'SR');
    return pickCard(rarity);
  });
  try {
    const results = await savePull(db, userId, drawn, now, 0, 0, ticketType);
    return { results, snapshot: await getSnapshot(userId, now) };
  } catch (error) {
    if (error instanceof InsufficientTickets) throw new GameError('not_enough_tickets', ticketMessage(ticketType, count));
    if (error instanceof Error && /chk_user_game_state_credits/.test(error.message)) {
      throw new GameError('not_enough_credits', '뽑기권이 부족해요.');
    }
    throw error;
  }
}

function ticketMessage(ticketType: TicketType, count: number): string {
  const label = ticketType === 'low' ? '하급 뽑기권' : ticketType === 'normal' ? '보통 뽑기권' : ticketType === 'ssr' ? 'SSR 이상 뽑기권' : 'SR 이상 뽑기권';
  return count === 1
    ? `${label}이 필요해요.`
    : `${count}장 뽑기에는 ${label} ${count}장이 필요해요.`;
}


/** What one redemption actually added. Counts are read back from the write, never assumed. */
export interface CouponGrant {
  low: number;
  credits: number;
  sr: number;
  ssr: number;
  /** Total card copies added, when the coupon granted cards instead of tickets. */
  cards?: number;
  /** Distinct cards that actually gained copies. */
  cardTypes?: number;
  /** Copies per card type when every written row moved by the same amount. */
  copiesPerCard?: number;
}

/** Case-insensitive once-per-user coupons. The 100-p coupons grant 20 guaranteed tickets each. */
const COUPONS: Record<string, CouponGrant> = {
  LIMKETMON: { credits: 10, low: 50, sr: 0, ssr: 1 },
  LIMKETMON_SR_100P: { credits: 0, low: 0, sr: 20, ssr: 0 },
  LIMKETMON_SSR_100P: { credits: 0, low: 0, sr: 0, ssr: 20 }
};

/** Repeatable server-only test coupon. The code lives in the runtime secret, never the client. */
function privateCouponCode(): string {
  return (env.PRIVATE_CARD_COUPON ?? '').trim().toUpperCase();
}

export async function redeemCoupon(userId: string, rawCode: string): Promise<{ snapshot: Snapshot; granted: CouponGrant }> {
  const code = rawCode.trim().toUpperCase();
  const db = getDatabase();
  const secret = privateCouponCode();
  const isPrivate = Boolean(secret && code === secret);
  const grant = isPrivate ? { credits: 100, low: 100, sr: 100, ssr: 100 } : Object.hasOwn(COUPONS, code) ? COUPONS[code] : undefined;
  if (!grant) throw new GameError('invalid_code', '유효하지 않은 쿠폰 코드입니다.');
  try {
    await db.batch([
      ...(isPrivate ? [] : [db.prepare(`
        INSERT INTO coupon_redemptions (user_id, coupon_code, redeemed_at)
        VALUES (?, ?, ?)
      `).bind(userId, code, new Date().toISOString())]),
      db.prepare(`
        UPDATE user_game_state SET
          pull_credits = pull_credits + ?,
          low_tickets = low_tickets + ?,
          sr_tickets = sr_tickets + ?,
          ssr_tickets = ssr_tickets + ?
        WHERE user_id = ?
      `).bind(grant.credits, grant.low, grant.sr, grant.ssr, userId)
    ]);
  } catch (error) {
    const redeemed = await db.prepare(`
      SELECT 1 FROM coupon_redemptions WHERE user_id = ? AND coupon_code = ?
    `).bind(userId, code).first();
    if (redeemed) throw new GameError('already_redeemed', '이미 사용한 쿠폰입니다.');
    throw error;
  }

  // These exact increments committed together; private test grants are repeatable.
  return { snapshot: await getSnapshot(userId), granted: { ...grant } };
}

/** Clear this player's game data atomically while keeping their sign-in identity. */
export async function resetAccount(userId: string): Promise<Snapshot> {
  const db = getDatabase();
  await db.batch([
    db.prepare('DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').bind(userId),
    ...['decks', 'inventory', 'pull_history', 'battles', 'user_achievements', 'reward_claims', 'coupon_redemptions', 'user_game_state']
      .map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
    db.prepare('INSERT INTO user_game_state (user_id) VALUES (?)').bind(userId)
  ]);
  return getSnapshot(userId);
}

export async function enhanceCard(userId: string, rawCardId: unknown): Promise<Snapshot> {
  if (typeof rawCardId !== 'string' || !rawCardId || rawCardId.length > 128) {
    throw new GameError('invalid_card', '카드를 찾을 수 없습니다.');
  }
  const db = getDatabase();
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await ownedRows(userId);
    const row = rows.find((entry) => entry.card_id === rawCardId);
    if (!row) throw new GameError('not_owned', '아직 없는 카드예요.');
    const progress = progressOf(row);
    const level = progress.enhanceLevel;
    if (level >= MAX_ENHANCE) throw new GameError('max_enhance', '이미 최대 강화예요.');
    const pool = rows.filter((entry) => (entry.base_card_id ?? entry.card_id) === progress.baseCardId)
      .sort((a, b) => a.card_id.localeCompare(b.card_id));
    const cost = enhanceCost(level);
    const available = pool.reduce((sum, entry) => sum + enhanceMaterials(entry.quantity), 0);
    if (available < cost) {
      throw new GameError('not_enough_copies', `강화 재료가 ${cost - available}장 부족해요. 각 보유 카드 한 장은 남겨 둡니다.`);
    }
    const writes: D1PreparedStatement[] = [ownedRowGuard(db, userId, row),
      db.prepare('UPDATE inventory SET enhance_level = enhance_level + 1 WHERE user_id = ? AND card_id = ?').bind(userId, rawCardId)];
    let remaining = cost;
    for (const donor of pool) {
      const quantity = Math.min(remaining, enhanceMaterials(donor.quantity));
      if (!quantity) continue;
      // The target was already guarded before its level increment. Later donor conflicts
      // abort this entire batch, including the increment and every preceding deduction.
      if (donor.card_id !== rawCardId) writes.push(ownedRowGuard(db, userId, donor));
      writes.push(db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND card_id = ?').bind(quantity, userId, donor.card_id));
      remaining -= quantity;
      if (!remaining) break;
    }
    try { await db.batch(writes); }
    catch (error) {
      if (error instanceof Error && /chk_user_game_state_credits/.test(error.message)) continue;
      throw error;
    }
    return getSnapshot(userId);
  }
  throw new GameError('enhance_busy', '다른 강화가 먼저 처리됐어요. 다시 시도해주세요.');
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

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

interface DeckRow {
  id: string;
  name: string;
  is_default: number;
  card_id: string | null;
  slot: number | null;
}

/** Group a deck/card join into one summary per deck, cards in slot order. */
function toDecks(rows: unknown): DeckSummary[] {
  const byId = new Map<string, DeckSummary>();
  for (const raw of rows as DeckRow[]) {
    let deck = byId.get(raw.id);
    if (!deck) {
      deck = { id: raw.id, name: raw.name, isDefault: raw.is_default === 1, cards: [] };
      byId.set(raw.id, deck);
    }
    if (raw.card_id) deck.cards.push(raw.card_id);
  }
  return [...byId.values()];
}

export async function listDecks(userId: string): Promise<DeckSummary[]> {
  const db = getDatabase();
  const result = await db.prepare(`
    SELECT d.id, d.name, d.is_default, c.card_id, c.slot
    FROM decks d LEFT JOIN deck_cards c ON c.deck_id = d.id
    WHERE d.user_id = ? ORDER BY d.created_at ASC, c.slot ASC
  `).bind(userId).all();
  return toDecks(result.results);
}

/** The first deck is free and becomes the default, so a new collector can play immediately. */
async function createStarterDeck(userId: string, rows: OwnedRow[]): Promise<void> {
  const db = getDatabase();
  const pool = [...new Map(rows.map((row) => [progressOf(row).baseCardId, ownedCard(row)])).values()];
  if (pool.length < DECK_SIZE) return;
  const strongest = [...pool]
    .sort((left, right) => rarityRankOf(right.rarity) - rarityRankOf(left.rarity) || left.version - right.version)
    .slice(0, DECK_SIZE);
  const now = new Date().toISOString();
  const deckId = crypto.randomUUID();
  try {
    await db.batch([
      // Idempotent: a concurrent read that also decided to seed a starter deck must not 503 the
      // caller (and must not fail a pull that already committed its cards).
      db.prepare(`INSERT INTO decks (id, user_id, name, is_default, created_at, updated_at)
        SELECT ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM decks WHERE user_id = ?)`)
        .bind(deckId, userId, '기본 덱', now, now, userId),
      ...strongest.map((card, slot) =>
        db.prepare('INSERT INTO deck_cards (deck_id, slot, card_id) VALUES (?, ?, ?)').bind(deckId, slot, card.id)
      )
    ]);
  } catch {
    // The deck already exists (or is being created); the snapshot will pick it up either way.
  }
}

function rarityRankOf(rarity: Rarity): number {
  return 5 - RARITY_ORDER.indexOf(rarity);
}

export async function saveDeck(userId: string, deckId: string, rawCardIds: unknown, now = new Date()): Promise<DeckSummary[]> {
  const db = getDatabase();
  const owned = await ownedRows(userId);
  const validated = validateOwnedDeck(rawCardIds, owned);
  if (!validated.ok) throw new GameError('invalid_deck', validated.error);
  const existing = await db.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?').bind(deckId, userId).first();
  if (!existing) throw new GameError('not_found', '덱을 찾을 수 없습니다.');
  await db.batch([
    db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').bind(deckId),
    ...validated.cards.map((cardId, slot) =>
      db.prepare('INSERT INTO deck_cards (deck_id, slot, card_id) VALUES (?, ?, ?)').bind(deckId, slot, cardId)
    ),
    db.prepare('UPDATE decks SET updated_at = ? WHERE id = ? AND user_id = ?').bind(now.toISOString(), deckId, userId)
  ]);
  return listDecks(userId);
}

export async function createDeck(userId: string, rawName: unknown, rawCardIds: unknown): Promise<DeckSummary[]> {
  const db = getDatabase();
  const name = normalizeDeckName(rawName);
  if (!name) throw new GameError('invalid_name', '덱 이름을 입력해주세요.');
  const owned = await ownedRows(userId);
  const validated = validateOwnedDeck(rawCardIds, owned);
  if (!validated.ok) throw new GameError('invalid_deck', validated.error);
  const count = await db.prepare('SELECT COUNT(*) AS total FROM decks WHERE user_id = ?').bind(userId).first();
  if (Number((count as { total: number } | null)?.total ?? 0) >= MAX_DECKS) {
    throw new GameError('too_many_decks', `덱은 최대 ${MAX_DECKS}개까지 만들 수 있습니다.`);
  }
  const taken = await db.prepare('SELECT 1 FROM decks WHERE user_id = ? AND name = ?').bind(userId, name).first();
  if (taken) throw new GameError('duplicate_name', '같은 이름의 덱이 이미 있습니다.');
  const deckId = crypto.randomUUID();
  const now = new Date().toISOString();
  // The count above is only a friendly early check; this guarded insert is what actually holds
  // the cap when two requests race, because one statement is atomic. The default flag is decided
  // inside the same statement so parallel creates cannot produce two default decks.
  await db.batch([
    db.prepare(`INSERT INTO decks (id, user_id, name, is_default, created_at, updated_at)
      SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM decks WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END, ?, ?
      WHERE (SELECT COUNT(*) FROM decks WHERE user_id = ?) < ?`)
      .bind(deckId, userId, name, userId, now, now, userId, MAX_DECKS),
    ...validated.cards.map((cardId, slot) =>
      db.prepare('INSERT INTO deck_cards (deck_id, slot, card_id) VALUES (?, ?, ?)').bind(deckId, slot, cardId)
    )
  ]);
  return listDecks(userId);
}

export async function renameDeck(userId: string, deckId: string, rawName: unknown): Promise<DeckSummary[]> {
  const db = getDatabase();
  const name = normalizeDeckName(rawName);
  if (!name) throw new GameError('invalid_name', '덱 이름을 입력해주세요.');
  const taken = await db
    .prepare('SELECT 1 FROM decks WHERE user_id = ? AND name = ? AND id != ?')
    .bind(userId, name, deckId)
    .first();
  if (taken) throw new GameError('duplicate_name', '같은 이름의 덱이 이미 있습니다.');
  const result = await db
    .prepare('UPDATE decks SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(name, new Date().toISOString(), deckId, userId)
    .run();
  if (!result.meta.changes) throw new GameError('not_found', '덱을 찾을 수 없습니다.');
  return listDecks(userId);
}

export async function deleteDeck(userId: string, deckId: string): Promise<DeckSummary[]> {
  const db = getDatabase();
  const deck = (await db
    .prepare('SELECT is_default FROM decks WHERE id = ? AND user_id = ?')
    .bind(deckId, userId)
    .first()) as { is_default: number } | null;
  if (!deck) throw new GameError('not_found', '덱을 찾을 수 없습니다.');
  await db.batch([
    db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').bind(deckId),
    db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?').bind(deckId, userId)
  ]);
  if (deck.is_default === 1) {
    // Promote the oldest remaining deck so the player always has a usable default.
    await db.prepare(`
      UPDATE decks SET is_default = 1 WHERE id = (
        SELECT id FROM decks WHERE user_id = ? ORDER BY created_at ASC LIMIT 1
      )
    `).bind(userId).run();
  }
  return listDecks(userId);
}

export async function setDefaultDeck(userId: string, deckId: string): Promise<DeckSummary[]> {
  const db = getDatabase();
  const deck = await db.prepare('SELECT 1 FROM decks WHERE id = ? AND user_id = ?').bind(deckId, userId).first();
  if (!deck) throw new GameError('not_found', '덱을 찾을 수 없습니다.');
  await db.batch([
    db.prepare('UPDATE decks SET is_default = 0 WHERE user_id = ? AND is_default = 1').bind(userId),
    db.prepare('UPDATE decks SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(new Date().toISOString(), deckId, userId)
  ]);
  return listDecks(userId);
}

/**
 * Fills a deck with the three strongest owned cards, or creates a deck for them when no deckId
 * is given. Deterministic: the same collection always produces the same deck.
 */
export async function autoDeck(userId: string, deckId?: unknown, now = new Date()): Promise<DeckSummary[]> {
  const db = getDatabase();
  const rows = await ownedRows(userId);
  const power = (row: OwnedRow) => {
    const card = ownedCard(row);
    const stats = applyEnhance(battleStats(card), row.enhance_level, card.rarity);
    return stats.maxHp + stats.atk * 2 + stats.def + stats.spd * 2;
  };
  const sorted = rows.sort((a, b) => power(b) - power(a) || a.card_id.localeCompare(b.card_id));
  const unique = new Map<string, OwnedRow>();
  for (const row of sorted) if (!unique.has(progressOf(row).baseCardId)) unique.set(progressOf(row).baseCardId, row);
  const picked = [...unique.values()].slice(0, DECK_SIZE).map((row) => row.card_id);
  if (picked.length < DECK_SIZE) throw new GameError('not_enough_cards', '서로 다른 종류 카드 3장이 필요해요.');
  if (typeof deckId === 'string' && deckId) return saveDeck(userId, deckId, picked, now);
  return createDeck(userId, '추천 덱', picked);
}

export interface OwnedRow {
  card_id: string; quantity: number; first_obtained_at: string; enhance_level: number;
  base_card_id: string | null; rarity_override: Rarity | null; traits: string;
}
/** The failing CHECK is inside D1's transaction, so stale reads roll back every preceding write. */
export function progressionGuard(db: D1Database, userId: string, condition: string, bindings: (string | number | null)[]) {
  return db.prepare(`UPDATE user_game_state SET pull_credits = CASE WHEN (${condition}) THEN pull_credits ELSE -1 END WHERE user_id = ?`)
    .bind(...bindings, userId);
}

export function ownedRowGuard(db: D1Database, userId: string, row: OwnedRow) {
  return progressionGuard(db, userId,
    'EXISTS (SELECT 1 FROM inventory WHERE user_id = ? AND card_id = ? AND quantity = ? AND enhance_level = ? AND traits = ? AND base_card_id IS ? AND rarity_override IS ?)',
    [userId, row.card_id, row.quantity, row.enhance_level, row.traits, row.base_card_id, row.rarity_override]);
}
export async function ownedRows(userId: string): Promise<OwnedRow[]> {
  const result = await getDatabase().prepare('SELECT * FROM inventory WHERE user_id = ?').bind(userId).all();
  return result.results as unknown as OwnedRow[];
}
export function progressOf(row: OwnedRow): CardProgress {
  const baseCardId = row.base_card_id ?? row.card_id;
  const base = CARD_BY_ID.get(baseCardId);
  if (!base) throw new GameError('invalid_card', '카드를 찾을 수 없습니다.');
  return { baseCardId, rarity: row.rarity_override ?? base.rarity, enhanceLevel: clampEnhance(row.enhance_level), traits: parseTraits(row.traits) };
}
function ownedCard(row: OwnedRow): Card {
  const progress = progressOf(row);
  return effectiveCard(CARD_BY_ID.get(progress.baseCardId)!, row.card_id, progress.rarity);
}
function validateOwnedDeck(raw: unknown, rows: OwnedRow[], options?: { maxRarity?: Rarity }) {
  const validated = validateDeck(raw, new Set(rows.map((row) => row.card_id)));
  if (!validated.ok) return validated;
  const progress = validated.cards.map((id) => progressOf(rows.find((row) => row.card_id === id)!));
  if (new Set(progress.map((p) => p.baseCardId)).size !== DECK_SIZE) return { ok: false as const, error: '같은 종류 카드를 중복 출전할 수 없습니다.' };
  if (options?.maxRarity && progress.some((p) => RARITY_ORDER.indexOf(p.rarity) < RARITY_ORDER.indexOf(options.maxRarity!))) {
    return { ok: false as const, error: '이번 규칙의 등급 제한을 초과합니다.' };
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------

interface BattleRowFull {
  id: string;
  kind: string;
  mode: string;
  opponent_id: string;
  kst_date: string;
  deck_id: string | null;
  ruleset_version: number;
  seed: number;
  deck_cards: string;
  modifier: string;
  decisions: string;
  result: string;
  rounds: number;
  damage_dealt: number;
  clutch: number;
  mvp_card_id: string | null;
  summary: string | null;
}

const BATTLE_COLUMNS = `SELECT id, kind, opponent_id, kst_date, deck_id, ruleset_version, seed, deck_cards, modifier,
  decisions, result, rounds, damage_dealt, clutch, mvp_card_id, summary, mode FROM battles`;

/** Pending rows are transient drafts; only this many may exist per account at once. */
const MAX_PENDING_BATTLES = 40;

/** Exact lifetime counters, straight from SQL so they never depend on a row window. */
async function battleCounters(userId: string): Promise<{ battles: number; wins: number; losses: number; bossClears: number; dailyClears: number; clutchWins: number; nOnlyWins: number }> {
  const db = getDatabase();
  const row = (await db
    .prepare(`SELECT
        COUNT(*) AS battles,
        COALESCE(SUM(result = 'won'), 0) AS wins,
        COALESCE(SUM(result = 'lost'), 0) AS losses,
        COALESCE(SUM(result = 'won' AND opponent_id = 'boss'), 0) AS bossClears,
        COALESCE(SUM(result = 'won' AND kind = 'daily'), 0) AS dailyClears,
        COALESCE(SUM(result = 'won' AND clutch = 1), 0) AS clutchWins,
        COALESCE(SUM(result = 'won' AND n_only = 1), 0) AS nOnlyWins
      FROM battles WHERE user_id = ? AND result != 'pending'`)
    .bind(userId)
    .first()) as Record<string, number> | null;
  return {
    battles: Number(row?.battles ?? 0),
    wins: Number(row?.wins ?? 0),
    losses: Number(row?.losses ?? 0),
    bossClears: Number(row?.bossClears ?? 0),
    dailyClears: Number(row?.dailyClears ?? 0),
    clutchWins: Number(row?.clutchWins ?? 0),
    nOnlyWins: Number(row?.nOnlyWins ?? 0)
  };
}

function dailySummary(date: string, claims: Set<string>): DailyChallengeSummary {
  const challenge: DailyChallenge = dailyChallenge(date);
  const opponent = opponentById(challenge.opponentId);
  return {
    id: challenge.id,
    date: challenge.date,
    title: challenge.title,
    description: challenge.description,
    ruleLabel: challenge.ruleLabel,
    opponentId: challenge.opponentId,
    opponentName: opponent?.name ?? challenge.opponentId,
    cleared: claims.has(`daily:${date}`),
    rewardCredits: challenge.rewardCredits,
    modifier: challenge.modifier
  };
}

function parseModifier(raw: string): BattleModifier {
  try {
    const parsed = JSON.parse(raw) as BattleModifier;
    return parsed && typeof parsed === 'object' && 'kind' in parsed ? parsed : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

function parseDecisions(raw: string): Decision[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Decision[]) : [];
  } catch {
    return [];
  }
}

function setupFromRow(row: BattleRowFull) {
  const mode = parseMode(row.mode);
  const opponent = opponentById(row.opponent_id, mode);
  const slots = parseDeckSlots(row.deck_cards);
  const cardIds = slots.map((slot) => slot.id);
  if (!opponent || cardIds.length !== DECK_SIZE || slots.some((slot) => !slot.progress)) return null;
  return buildSetup({
    kind: row.kind === 'daily' ? 'daily' : 'pve',
    mode,
    opponentId: row.opponent_id,
    modifier: parseModifier(row.modifier),
    seed: Number(row.seed),
    playerCardIds: cardIds,
    playerEnhance: slots.map((slot) => slot.enhance),
    playerProgress: slots.map((slot) => slot.progress!),
    battleId: row.id
  });
}

/** Stored mode strings are untrusted: anything unknown falls back to normal. */
function parseMode(raw: unknown): BattleMode {
  return BATTLE_MODES.includes(raw as BattleMode) ? (raw as BattleMode) : 'normal';
}

/**
 * Starts a battle. The server owns the seed, opponent, rules and deck snapshot, so a client can
 * only ever ask for a legal battle with cards it actually owns.
 */
export async function startBattle(
  userId: string,
  input: { deckId?: unknown; opponentId?: unknown; kind?: unknown; mode?: unknown },
  now = new Date()
): Promise<BattleSetupResponse> {
  const db = getDatabase();
  if (typeof input.deckId !== 'string') throw new GameError('invalid_deck', '덱을 선택해주세요.');
  const kind = input.kind === 'daily' ? 'daily' : 'pve';
  // The daily is its own normal-mode challenge; only explicit PvE battles carry a mode.
  const mode: BattleMode = kind === 'daily' ? 'normal' : parseMode(input.mode);
  const kst = kstDate(now);

  const deckRow = (await db
    .prepare('SELECT id, name FROM decks WHERE id = ? AND user_id = ?')
    .bind(input.deckId, userId)
    .first()) as { id: string; name: string } | null;
  if (!deckRow) throw new GameError('not_found', '덱을 찾을 수 없습니다.');
  const deckCards = (await db
    .prepare('SELECT card_id FROM deck_cards WHERE deck_id = ? ORDER BY slot ASC')
    .bind(deckRow.id)
    .all()).results as Array<{ card_id: string }>;
  const cardIds = deckCards.map((row) => row.card_id);
  const owned = await ownedRows(userId);

  let opponentId: string;
  let modifier: BattleModifier;
  if (kind === 'daily') {
    const challenge = dailyChallenge(kst);
    opponentId = challenge.opponentId;
    modifier = challenge.modifier;
  } else {
    if (typeof input.opponentId !== 'string' || !opponentById(input.opponentId)) {
      throw new GameError('invalid_opponent', '상대를 선택해주세요.');
    }
    opponentId = input.opponentId;
    modifier = { kind: 'none' };
    // Unlock is enforced server-side; the client's mode selector is only a hint.
    if (mode !== 'normal' && !(await unlockedModesFor(userId)).includes(mode)) {
      throw new GameError('mode_locked', `${MODE_LABELS[mode]} 모드는 아직 잠겨 있어요.`);
    }
  }

  const validated = validateOwnedDeck(
    cardIds,
    owned,
    modifier.kind === 'rarity_cap' ? { maxRarity: modifier.max } : undefined
  );
  if (!validated.ok) throw new GameError('invalid_deck', validated.error);

  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const battleId = crypto.randomUUID();
  const snapshot = validated.cards.map((id) => {
    const progress = progressOf(owned.find((row) => row.card_id === id)!);
    return { id, lv: progress.enhanceLevel, progress };
  });
  const setup = buildSetup({ kind, mode, opponentId, modifier, seed, playerCardIds: validated.cards, playerEnhance: snapshot.map((slot) => slot.lv), playerProgress: snapshot.map((slot) => slot.progress), battleId });
  const opponent = opponentById(opponentId, mode)!;

  // Keep the table bounded: an authenticated client could otherwise open battles forever.
  await db.prepare(`
    DELETE FROM battles WHERE user_id = ? AND result = 'pending' AND id NOT IN (
      SELECT id FROM battles WHERE user_id = ? AND result = 'pending' ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `).bind(userId, userId, MAX_PENDING_BATTLES - 1).run();
  const insertBattle = db.prepare(`
    INSERT INTO battles
      (id, user_id, kind, mode, opponent_id, deck_id, ruleset_version, seed, deck_cards, modifier, decisions, result, kst_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?)
  `).bind(
    battleId,
    userId,
    kind,
    mode,
    opponentId,
    deckRow.id,
    BATTLE_RULESET_VERSION,
    seed,
    JSON.stringify(snapshot),
    JSON.stringify(modifier),
    kst,
    now.toISOString()
  );
  await db.batch([
    ...validated.cards.map((id) => ownedRowGuard(db, userId, owned.find((entry) => entry.card_id === id)!)),
    insertBattle
  ]);

  return {
    battleId,
    ruleset: BATTLE_RULESET_VERSION,
    seed,
    kind,
    mode,
    opponentId,
    opponentName: opponent.name,
    opponentTitle: opponent.title,
    difficulty: opponent.difficulty,
    modifier,
    player: setup.player,
    opponent: setup.opponent
  };
}

/**
 * Finishes a pending battle. The client's battle is only a preview: this re-simulates from the
 * stored seed, deck snapshot and submitted decisions, then grants rewards in one transaction.
 */
export async function finishBattle(
  userId: string,
  battleId: string,
  decisions: unknown,
  now = new Date()
): Promise<BattleResultSummary> {
  const db = getDatabase();
  if (typeof battleId !== 'string' || battleId.length > 64) {
    throw new GameError('invalid_battle', '전투를 찾을 수 없습니다.');
  }
  if (!Array.isArray(decisions) || decisions.length > 400) {
    throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
  }
  const submitted: Decision[] = [];
  for (const raw of decisions) {
    if (!raw || typeof raw !== 'object') throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    const entry = raw as { uid?: unknown; action?: unknown; skillId?: unknown };
    if (typeof entry.uid !== 'string' || entry.uid.length > 8) {
      throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    }
    if (entry.action !== 'attack' && entry.action !== 'skill') {
      throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    }
    // An explicit skill id must be a short, non-empty string; whether the combatant actually owns
    // it is decided by the engine during re-simulation, which refuses an unlawful battle.
    if (entry.skillId === undefined) {
      submitted.push({ uid: entry.uid, action: entry.action });
      continue;
    }
    if (typeof entry.skillId !== 'string' || entry.skillId.length === 0 || entry.skillId.length > 64) {
      throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    }
    submitted.push({ uid: entry.uid, action: entry.action, skillId: entry.skillId });
  }

  const row = (await db
    .prepare(`${BATTLE_COLUMNS} WHERE id = ? AND user_id = ?`)
    .bind(battleId, userId)
    .first()) as BattleRowFull | null;
  if (!row) throw new GameError('not_found', '전투를 찾을 수 없습니다.');
  // Repeat calls are answered from the settled row, but always re-derived from the reward_claims
  // rows this battle actually inserted. The stored summary can still be the provisional one written
  // inside the settlement batch (empty rewards) if the request died before the post-commit summary
  // write, and a retry must never report less than was really paid.
  if (row.result !== 'pending') return buildAuthoritativeSummary(db, userId, battleId, row);
  if (Number(row.ruleset_version) !== BATTLE_RULESET_VERSION) {
    const summary = invalidSummary(row);
    await db
      .prepare("UPDATE battles SET result = 'invalid', summary = ?, completed_at = ? WHERE id = ? AND user_id = ? AND result = 'pending'")
      .bind(JSON.stringify(summary), now.toISOString(), battleId, userId)
      .run();
    return summary;
  }

  const mode = parseMode(row.mode);
  const setup = setupFromRow(row);
  const opponent = opponentById(row.opponent_id, mode);
  if (!setup || !opponent) throw new GameError('invalid_battle', '전투를 재현할 수 없습니다.');

  const simulation = runBattle(setup, submitted, (state) => aiDecision(state, opponent.profile));
  const result: BattleResultSummary['result'] = simulation.error
    ? 'invalid'
    : simulation.state.status === 'won'
      ? 'won'
      : simulation.state.status === 'lost'
        ? 'lost'
        : 'draw';
  if (result === 'invalid') {
    // The submitted log did not reproduce a legal battle. Nothing is paid and the battle stays
    // pending, so a client that lost its log can retry instead of losing the first-clear reward
    // to a permanently frozen row.
    return invalidSummary(row);
  }

  // Store only the player's decisions. runBattle records both sides in turn order, and replaying
  // a log that mixes them would feed the opponent's choices to the player's next turn.
  const playerUids = new Set(setup.player.map((entry, slot) => `a${slot}`));
  const verified = simulation.decisions.filter((decision) => playerUids.has(decision.uid));
  const damage = Object.values(simulation.state.damageBy).reduce((sum, value) => sum + value, 0);
  const clutch =
    result === 'won' &&
    simulation.state.sides.a.some((combatant) => combatant.hp > 0 && combatant.hp <= combatant.maxHp * 0.1);
  // The reward belongs to the day the challenge was issued, not to the day it was settled:
  // using "now" would let a player bank an easy day's battle and cash it in later.
  const kst = row.kst_date;
  // Bounded to the keys this settlement can read: first clears for this opponent/mode, the daily
  // key for the battle's own KST date, and the achievement keys.
  const claims = await progressClaims(userId, kst);
  const plan = row.kind === 'daily' ? planBattleRewards({ kind: 'daily', opponentId: row.opponent_id, mode, result, kstDate: kst, firstClear: false, battleId }, 0) : { credits: 0, claims: [], lines: [] };
  const victory = result === 'won' && row.kind !== 'daily' ? victoryTicketReward(mode, row.opponent_id) : null;
  const progress = await achievementProgress(userId, {
    won: result === 'won',
    opponentId: row.opponent_id,
    kind: row.kind,
    cardIds: safeCards(row.deck_cards),
    nOnly: setup.player.every((card) => card.rarity === 'N'),
    clutch
  });
  const unlocked = evaluateAchievements(progress).filter((id) => !claims.has(achievementClaimKey(id)));
  const claimedAt = now.toISOString();
  const summary: BattleResultSummary = {
    result,
    rewards: [],
    unlocked,
    mvpCardId: mvpCardId(simulation.state),
    rounds: simulation.state.round,
    damageDealt: damage
  };
  const nOnly = setup.player.every((card) => card.rarity === 'N') ? 1 : 0;

  try {
    await db.batch([
      // A reset may have deleted this battle while the simulation was running.
      progressionGuard(db, userId, "EXISTS (SELECT 1 FROM battles WHERE id = ? AND user_id = ? AND result = 'pending')", [battleId, userId]),
      // Settlement lock: exactly one request can ever insert this key, and because a D1 batch is
      // one transaction, a loser's whole payout rolls back instead of paying a second time.
      db.prepare('INSERT INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES (?, ?, 0, ?, ?)')
        .bind(userId, `settle:${battleId}`, battleId, claimedAt),
      db.prepare(`UPDATE battles SET result = ?, rounds = ?, damage_dealt = ?, clutch = ?, mvp_card_id = ?,
          n_only = ?, decisions = ?, summary = ?, completed_at = ?
        WHERE id = ? AND user_id = ? AND result = 'pending'`)
        .bind(result, simulation.state.round, damage, clutch ? 1 : 0, summary.mvpCardId, nOnly, JSON.stringify(verified), JSON.stringify(summary), claimedAt, battleId, userId),
      ...plan.claims.map((claim) => db.prepare('INSERT OR IGNORE INTO reward_claims (user_id, claim_key, credits, ticket_type, ticket_quantity, battle_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, claim.key, claim.credits, claim.ticketType ?? null, claim.quantity ?? 0, battleId, claimedAt)),
      ...(victory ? [`ticket:${battleId}`, pveFirstClearClaimKey(row.opponent_id, mode)].map((key) =>
        db.prepare('INSERT OR IGNORE INTO reward_claims (user_id, claim_key, credits, ticket_type, ticket_quantity, battle_id, claimed_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
          .bind(userId, key, victory.ticketType, victory.quantity, battleId, claimedAt)) : []),
      ...unlocked.map((id) =>
        db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)')
          .bind(userId, id, claimedAt)
      ),
      ...unlocked.map((id) =>
        db.prepare('INSERT OR IGNORE INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, achievementClaimKey(id), achievementById(id)?.reward ?? 0, battleId, claimedAt)
      ),
      // Credits come from the claims that actually landed in this transaction, so a concurrent
      // finish of the same battle cannot pay twice. claimed_at is this request's nonce.
      db.prepare(`UPDATE user_game_state SET pull_credits = pull_credits + (
          SELECT COALESCE(SUM(credits + CASE WHEN ticket_type = 'normal' THEN ticket_quantity ELSE 0 END), 0) FROM reward_claims
          WHERE user_id = ? AND battle_id = ? AND claimed_at = ?
        ),
        low_tickets = low_tickets + (
          SELECT COALESCE(SUM(CASE WHEN ticket_type = 'low' THEN ticket_quantity ELSE 0 END), 0) FROM reward_claims
          WHERE user_id = ? AND battle_id = ? AND claimed_at = ?
        ),
        sr_tickets = sr_tickets + (
          SELECT COALESCE(SUM(CASE WHEN ticket_type = 'sr' THEN ticket_quantity ELSE 0 END), 0) FROM reward_claims
          WHERE user_id = ? AND battle_id = ? AND claimed_at = ?
        ),
        ssr_tickets = ssr_tickets + (
          SELECT COALESCE(SUM(CASE WHEN ticket_type = 'ssr' THEN ticket_quantity ELSE 0 END), 0) FROM reward_claims
          WHERE user_id = ? AND battle_id = ? AND claimed_at = ?
        ) WHERE user_id = ?`)
        .bind(userId, battleId, claimedAt, userId, battleId, claimedAt, userId, battleId, claimedAt, userId, battleId, claimedAt, userId)
    ]);
  } catch (error) {
    const settled = (await db
      .prepare(`${BATTLE_COLUMNS} WHERE id = ? AND user_id = ?`)
      .bind(battleId, userId)
      .first()) as BattleRowFull | null;
    // Another request settled this battle first (its claims rolled us back).
    if (settled && settled.result !== 'pending') {
      return buildAuthoritativeSummary(db, userId, battleId, settled);
    }
    throw error;
  }
  return buildAuthoritativeSummary(db, userId, battleId, row, summary, verified);
}

async function buildAuthoritativeSummary(
  db: D1Database,
  userId: string,
  battleId: string,
  row: BattleRowFull,
  baseSummary?: BattleResultSummary,
  verifiedDecisions?: Decision[]
): Promise<BattleResultSummary> {
  // Read back actual inserted claims for this battle to build authoritative paid summary.
  const actualClaimsResult = await db.prepare(
    'SELECT claim_key, credits, ticket_type, ticket_quantity FROM reward_claims WHERE user_id = ? AND battle_id = ? AND claim_key != ?'
  ).bind(userId, battleId, `settle:${battleId}`).all();
  const actualClaims = actualClaimsResult.results as Array<{ claim_key: string; credits: number; ticket_type: string | null; ticket_quantity: number }>;
  const actualRewards: RewardLine[] = [];
  for (const c of actualClaims) {
    if (c.credits > 0) {
      let label = '격파 보상';
      if (c.claim_key.startsWith('pve_first:')) label = '첫 격파 보상';
      else if (c.claim_key.startsWith('daily:')) label = '데일리 챌린지 보상';
      else if (c.claim_key.startsWith('achievement:')) {
        const achId = c.claim_key.replace('achievement:', '');
        label = `업적 · ${achievementById(achId)?.name ?? achId}`;
      }
      actualRewards.push({ label, credits: c.credits });
    }
    if (c.ticket_type && c.ticket_quantity > 0) {
      actualRewards.push({
        label: c.ticket_type === 'low' ? '하급 뽑기권' : c.ticket_type === 'normal' ? '보통 뽑기권' : c.ticket_type === 'ssr' ? 'SSR 이상 뽑기권' : 'SR 이상 뽑기권',
        credits: 0,
        ticketType: c.ticket_type as TicketType,
        quantity: c.ticket_quantity
      });
    }
  }
  const prevSummary = row.summary ? cachedSummary(row) : null;
  // Achievements come from the claim rows this battle actually inserted. A stored summary could
  // advertise an unlock whose user_achievements write lost a concurrent distinct-battle race.
  const unlocked = actualClaims
    .filter((claim) => claim.claim_key.startsWith('achievement:'))
    .map((claim) => claim.claim_key.slice('achievement:'.length));
  const finalSummary: BattleResultSummary = {
    result: baseSummary?.result ?? prevSummary?.result ?? (row.result === 'pending' ? 'invalid' : row.result as BattleResultSummary['result']),
    mvpCardId: baseSummary?.mvpCardId ?? prevSummary?.mvpCardId ?? row.mvp_card_id,
    rounds: baseSummary?.rounds ?? prevSummary?.rounds ?? Number(row.rounds ?? 0),
    damageDealt: baseSummary?.damageDealt ?? prevSummary?.damageDealt ?? Number(row.damage_dealt ?? 0),
    unlocked,
    rewards: actualRewards
  };
  // Persist the actual paid summary in the battle row so future cached reads match the real receipt.
  await db.prepare('UPDATE battles SET summary = ? WHERE id = ? AND user_id = ?')
    .bind(JSON.stringify(finalSummary), battleId, userId).run();
  return finalSummary;
}

/**
 * Every reward_claims key a progress read can depend on: the 15 first-clear keys (5 opponents x 3
 * modes), the 8 achievement keys and the single daily key for `date`. Bounded at 24 keys, so the
 * read stays flat no matter how many battles have been settled (each one also writes its own
 * settle:<id> and ticket_drop:<id> rows, which no progress query needs). The lookup uses the
 * (user_id, claim_key) primary key.
 */
function progressClaimKeys(date: string): string[] {
  const keys: string[] = [];
  for (const mode of BATTLE_MODES) for (const opponent of OPPONENTS) keys.push(pveFirstClearClaimKey(opponent.id, mode));
  for (const achievement of ACHIEVEMENTS) keys.push(achievementClaimKey(achievement.id));
  keys.push(dailyClaimKey(date));
  return keys;
}

/** Bounded replacement for a full reward_claims scan; see progressClaimKeys. */
async function progressClaims(userId: string, date: string): Promise<Set<string>> {
  const db = getDatabase();
  const keys = progressClaimKeys(date);
  const result = await db
    .prepare(`SELECT claim_key FROM reward_claims WHERE user_id = ? AND claim_key IN (${keys.map(() => '?').join(', ')})`)
    .bind(userId, ...keys)
    .all();
  return new Set((result.results as Array<{ claim_key: string }>).map((row) => row.claim_key));
}

/** All five normal firsts unlock hard; all five hard firsts unlock chaos. Normal is always open. */
function unlockedModesFrom(clearedByMode: Record<BattleMode, string[]>): BattleMode[] {
  const modes: BattleMode[] = ['normal'];
  if (clearedByMode.normal.length === OPPONENTS.length) modes.push('hard');
  if (clearedByMode.hard.length === OPPONENTS.length) modes.push('chaos');
  return modes;
}

async function unlockedModesFor(userId: string): Promise<BattleMode[]> {
  const claims = await progressClaims(userId, kstDate(new Date()));
  const clearedByMode: Record<BattleMode, string[]> = { normal: [], hard: [], chaos: [] };
  for (const mode of BATTLE_MODES) {
    clearedByMode[mode] = OPPONENTS.filter((opponent) => claims.has(pveFirstClearClaimKey(opponent.id, mode))).map(
      (opponent) => opponent.id
    );
  }
  return unlockedModesFrom(clearedByMode);
}

/** Cumulative achievement counters, including the battle that is finishing right now. */
async function achievementProgress(
  userId: string,
  pending: { won: boolean; opponentId: string; kind: string; cardIds: string[]; nOnly: boolean; clutch: boolean }
): Promise<AchievementProgress> {
  const db = getDatabase();
  const [pullResult, inventoryResult] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total FROM pull_history WHERE user_id = ?').bind(userId),
    db.prepare('SELECT * FROM inventory WHERE user_id = ?').bind(userId)
  ]);
  const counters = await battleCounters(userId);
  const owned = inventoryResult.results as unknown as OwnedRow[];
  const pulls = pullResult.results[0] as { total: number } | undefined;
  return {
    // The battle being settled is already stored as pending, so its win is not counted yet.
    wins: counters.wins + (pending.won ? 1 : 0),
    losses: counters.losses + (pending.won ? 0 : 1),
    bossClears: counters.bossClears + (pending.won && pending.opponentId === 'boss' ? 1 : 0),
    dailyClears: counters.dailyClears + (pending.won && pending.kind === 'daily' ? 1 : 0),
    nOnlyWins:
      counters.nOnlyWins +
      (pending.won && pending.nOnly ? 1 : 0),
    clutchWins: counters.clutchWins + (pending.won && pending.clutch ? 1 : 0),
    totalPulls: Number(pulls?.total ?? 0),
    ownedRarities: [...new Set(owned.map((row) => progressOf(row).rarity).filter((value): value is Rarity => Boolean(value)))]
  };
}

/** The best-damage surviving card on the player side, by card id. */
function mvpCardId(state: BattleState): string | null {
  let best: { cardId: string; damage: number } | null = null;
  for (const combatant of state.sides.a) {
    const damage = state.damageBy[combatant.uid] ?? 0;
    if (!best || damage > best.damage) best = { cardId: combatant.cardId, damage };
  }
  return best && best.damage > 0 ? best.cardId : null;
}

function invalidSummary(row: BattleRowFull): BattleResultSummary {
  return {
    result: 'invalid',
    rewards: [],
    unlocked: [],
    mvpCardId: null,
    rounds: Number(row.rounds ?? 0),
    damageDealt: Number(row.damage_dealt ?? 0)
  };
}

function cachedSummary(row: BattleRowFull): BattleResultSummary {
  if (row.summary) {
    try {
      return JSON.parse(row.summary) as BattleResultSummary;
    } catch {
      // Fall through to a derived summary.
    }
  }
  return {
    result: row.result === 'won' || row.result === 'lost' || row.result === 'draw' ? row.result : 'invalid',
    rewards: [],
    unlocked: [],
    mvpCardId: row.mvp_card_id,
    rounds: Number(row.rounds ?? 0),
    damageDealt: Number(row.damage_dealt ?? 0)
  };
}

/** Replays a stored battle from its own recorded inputs. */
export async function replayBattle(userId: string, battleId: string) {
  const db = getDatabase();
  const row = (await db
    .prepare(`${BATTLE_COLUMNS} WHERE id = ? AND user_id = ?`)
    .bind(battleId, userId)
    .first()) as BattleRowFull | null;
  if (!row) throw new GameError('not_found', '전투를 찾을 수 없습니다.');
  if (Number(row.ruleset_version) !== BATTLE_RULESET_VERSION) throw new GameError('old_ruleset', '이전 규칙의 전투는 재생할 수 없습니다.');
  const setup = setupFromRow(row);
  const mode = parseMode(row.mode);
  const opponent = opponentById(row.opponent_id, mode);
  if (!setup || !opponent) throw new GameError('invalid_battle', '전투를 재현할 수 없습니다.');
  const decisions = parseDecisions(row.decisions);
  const simulation = runBattle(setup, decisions, (state) => aiDecision(state, opponent.profile));
  return {
    battleId: row.id,
    rulesetVersion: Number(row.ruleset_version),
    seed: Number(row.seed),
    kind: row.kind,
    mode,
    opponentId: row.opponent_id,
    opponentName: opponent.name,
    result: row.result,
    setup,
    decisions,
    events: simulation.events as BattleEvent[],
    verified: !simulation.error && simulation.state.status === row.result,
    error: simulation.error ?? null
  };
}
