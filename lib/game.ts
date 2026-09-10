import 'server-only';
import { getDatabase } from '../db/index';
import manifest from './data/cards.curated.json';
import type { Card } from './cards';
import { isHardPity, kstDate, nextPityCounter, RARITY_ORDER, rollRarityWithPity, untilHardPity, type Rarity } from './rules';
import { savePull } from './pull';
import { DECK_SIZE, MAX_DECKS, normalizeDeckName, validateDeck } from './decks';
import { dailyChallenge, type DailyChallenge } from './daily';
import { ACHIEVEMENTS, achievementById, achievementClaimKey, evaluateAchievements, type AchievementProgress } from './achievements';
import { planBattleRewards, pveFirstClearClaimKey } from './rewards';
import { summarizeBattles, type BattleRow } from './stats';
import { CATALOG, buildSetup, CARD_BY_ID } from './battle/setup';
import { battleStats } from './battle/stats';
import { BATTLE_RULESET_VERSION, type BattleEvent, type BattleModifier, type BattleState, type Decision } from './battle/types';
import { OPPONENTS, opponentById } from './battle/opponents';
import { aiDecision } from './battle/ai';
import { runBattle } from './battle/simulate';
import type { BattleResultSummary, BattleSetupResponse, BattleSummaryRow, DailyChallengeSummary, DeckSummary, RewardLine, StatsSummary } from './battle/api';

export type { Card } from './cards';

export interface Snapshot {
  freeAvailable: boolean;
  credits: number;
  completion: number;
  inventory: Array<{ cardId: string; quantity: number; firstObtainedAt: string }>;
  /** Pulls remaining before the hard pity guarantee. */
  pityRemaining: number;
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
    pityRemaining: untilHardPity(0),
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
  const [stateResult, inventoryResult, deckResult, claimResult, battleResult, achievementResult, pullResult] = await db.batch([
    db.prepare('SELECT pull_credits, last_free_pull_date, pity_counter FROM user_game_state WHERE user_id = ?').bind(userId),
    db.prepare(`
      SELECT card_id, quantity, first_obtained_at
      FROM inventory WHERE user_id = ? ORDER BY card_id
    `).bind(userId),
    db.prepare(`
      SELECT d.id, d.name, d.is_default, c.card_id, c.slot
      FROM decks d LEFT JOIN deck_cards c ON c.deck_id = d.id
      WHERE d.user_id = ? ORDER BY d.created_at ASC, c.slot ASC
    `).bind(userId),
    db.prepare('SELECT claim_key FROM reward_claims WHERE user_id = ?').bind(userId),
    db.prepare(`
      SELECT id, result, kind, opponent_id, kst_date, created_at, deck_cards, mvp_card_id, damage_dealt
      FROM battles WHERE user_id = ? AND result != 'pending'
      ORDER BY created_at DESC LIMIT 200
    `).bind(userId),
    db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').bind(userId),
    db.prepare('SELECT rarity, COUNT(*) AS total FROM pull_history WHERE user_id = ? GROUP BY rarity').bind(userId)
  ]);
  const state = stateResult.results[0] as
    | { pull_credits: number; last_free_pull_date: string | null; pity_counter: number }
    | undefined;
  const inventory = inventoryResult.results as Array<{
    card_id: string;
    quantity: number;
    first_obtained_at: string;
  }>;
  const owned = inventory.length;
  const pityCounter = Number(state?.pity_counter ?? 0);
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
  const decks = toDecks(deckResult.results);
  const starter = decks.length === 0 && owned >= DECK_SIZE;
  if (starter) await createStarterDeck(userId, inventory.map((row) => row.card_id));
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

  return {
    freeAvailable: state?.last_free_pull_date !== kstDate(now),
    credits: state?.pull_credits ?? 0,
    completion: Math.round((owned / cards.length) * 100),
    pityRemaining: untilHardPity(pityCounter),
    decks: starter ? await listDecks(userId) : decks,
    daily: dailySummary(kstDate(now), claims),
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
      firstObtainedAt: item.first_obtained_at
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
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}


export async function pullCards(userId: string, count: 1 | 5): Promise<{
  results: PullResult[];
  snapshot: Snapshot;
}> {
  const db = getDatabase();
  const now = new Date();
  // The roll depends on the pity counter, and the pull transaction accepts the draw only if the
  // counter it read is still current. A request that loses that race is refused and retries, so
  // parallel pulls can never each collect the same hard-pity guarantee.
  for (let attempt = 0; ; attempt++) {
    const state = (await db
      .prepare('SELECT pity_counter FROM user_game_state WHERE user_id = ?')
      .bind(userId)
      .first()) as { pity_counter: number } | null;
    let counter = Number(state?.pity_counter ?? 0);
    const fromPity = counter;
    const drawn: Card[] = [];
    for (let index = 0; index < count; index++) {
      const rarity = rollRarityWithPity(randomUnit(), counter);
      drawn.push(pickCard(rarity));
      counter = nextPityCounter(counter, rarity);
    }
    try {
      const results = await savePull(db, userId, drawn, now, fromPity, counter);
      return { results, snapshot: await getSnapshot(userId, now) };
    } catch (error) {
      if (error instanceof Error && /chk_user_game_state_credits/.test(error.message)) {
        throw new GameError('not_enough_credits', count === 5
          ? '5장 뽑기에는 뽑기권 5장이 필요해요.'
          : '오늘의 무료 뽑기를 사용했고, 뽑기권이 부족해요.');
      }
      // Another pull moved the counter first; redraw against the value it committed.
      if (error instanceof Error && /pity_changed/.test(error.message) && attempt < 12) continue;
      throw error;
    }
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
async function createStarterDeck(userId: string, ownedCardIds: string[]): Promise<void> {
  const db = getDatabase();
  const pool = ownedCardIds.map((id) => CARD_BY_ID.get(id)).filter((card): card is Card => Boolean(card));
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
  const owned = await ownedCards(userId);
  const validated = validateDeck(rawCardIds, owned);
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
  const owned = await ownedCards(userId);
  const validated = validateDeck(rawCardIds, owned);
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
  const inserted = await db.prepare(`INSERT INTO decks (id, user_id, name, is_default, created_at, updated_at)
    SELECT ?, ?, ?,
      (SELECT CASE WHEN EXISTS (SELECT 1 FROM decks WHERE user_id = ? AND is_default = 1) THEN 0 ELSE 1 END),
      ?, ?
    WHERE (SELECT COUNT(*) FROM decks WHERE user_id = ?) < ?`)
    .bind(deckId, userId, name, userId, now, now, userId, MAX_DECKS)
    .run();
  if (!Number((inserted.meta as { changes?: number }).changes ?? 0)) {
    throw new GameError('too_many_decks', `덱은 최대 ${MAX_DECKS}개까지 만들 수 있습니다.`);
  }
  await db.batch(
    validated.cards.map((cardId, slot) =>
      db.prepare('INSERT INTO deck_cards (deck_id, slot, card_id) VALUES (?, ?, ?)').bind(deckId, slot, cardId)
    )
  );
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
  const owned = [...(await ownedCards(userId))];
  if (owned.length < DECK_SIZE) {
    throw new GameError('not_enough_cards', `추천 덱을 만들려면 카드가 ${DECK_SIZE}장 필요해요.`);
  }
  const picked = owned.sort(compareBattlePower).slice(0, DECK_SIZE);
  if (typeof deckId === 'string' && deckId) return saveDeck(userId, deckId, picked, now);
  return createDeck(userId, '추천 덱', picked);
}

/** Highest battle value first, then rarity, then catalog order. Ties are never arbitrary. */
function compareBattlePower(leftId: string, rightId: string): number {
  const left = CARD_BY_ID.get(leftId);
  const right = CARD_BY_ID.get(rightId);
  if (!left || !right) return leftId.localeCompare(rightId);
  const power = (card: Card) => {
    const stats = battleStats(card);
    return stats.maxHp + stats.atk * 2 + stats.def + stats.spd * 2;
  };
  return power(right) - power(left) || left.version - right.version;
}

async function ownedCards(userId: string): Promise<Set<string>> {
  const db = getDatabase();
  const result = await db.prepare('SELECT card_id FROM inventory WHERE user_id = ?').bind(userId).all();
  return new Set((result.results as Array<{ card_id: string }>).map((row) => row.card_id));
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------

interface BattleRowFull {
  id: string;
  kind: string;
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
  decisions, result, rounds, damage_dealt, clutch, mvp_card_id, summary FROM battles`;

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
  const opponent = opponentById(row.opponent_id);
  const cardIds = safeCards(row.deck_cards);
  if (!opponent || cardIds.length !== DECK_SIZE) return null;
  return buildSetup({
    kind: row.kind === 'daily' ? 'daily' : 'pve',
    opponentId: row.opponent_id,
    modifier: parseModifier(row.modifier),
    seed: Number(row.seed),
    playerCardIds: cardIds,
    battleId: row.id
  });
}

/**
 * Starts a battle. The server owns the seed, opponent, rules and deck snapshot, so a client can
 * only ever ask for a legal battle with cards it actually owns.
 */
export async function startBattle(
  userId: string,
  input: { deckId?: unknown; opponentId?: unknown; kind?: unknown },
  now = new Date()
): Promise<BattleSetupResponse> {
  const db = getDatabase();
  if (typeof input.deckId !== 'string') throw new GameError('invalid_deck', '덱을 선택해주세요.');
  const kind = input.kind === 'daily' ? 'daily' : 'pve';
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
  const owned = await ownedCards(userId);

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
  }

  const validated = validateDeck(
    cardIds,
    owned,
    modifier.kind === 'rarity_cap' ? { maxRarity: modifier.max } : undefined
  );
  if (!validated.ok) throw new GameError('invalid_deck', validated.error);

  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const battleId = crypto.randomUUID();
  const setup = buildSetup({ kind, opponentId, modifier, seed, playerCardIds: validated.cards, battleId });
  const opponent = opponentById(opponentId)!;

  // Keep the table bounded: an authenticated client could otherwise open battles forever.
  await db.prepare(`
    DELETE FROM battles WHERE user_id = ? AND result = 'pending' AND id NOT IN (
      SELECT id FROM battles WHERE user_id = ? AND result = 'pending' ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `).bind(userId, userId, MAX_PENDING_BATTLES - 1).run();
  await db.prepare(`
    INSERT INTO battles
      (id, user_id, kind, opponent_id, deck_id, ruleset_version, seed, deck_cards, modifier, decisions, result, kst_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?)
  `).bind(
    battleId,
    userId,
    kind,
    opponentId,
    deckRow.id,
    BATTLE_RULESET_VERSION,
    seed,
    JSON.stringify(validated.cards),
    JSON.stringify(modifier),
    kst,
    now.toISOString()
  ).run();

  return {
    battleId,
    ruleset: BATTLE_RULESET_VERSION,
    seed,
    kind,
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
    const entry = raw as { uid?: unknown; action?: unknown };
    if (typeof entry.uid !== 'string' || entry.uid.length > 8) {
      throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    }
    if (entry.action !== 'attack' && entry.action !== 'skill') {
      throw new GameError('invalid_decisions', '전투 기록이 올바르지 않습니다.');
    }
    submitted.push({ uid: entry.uid, action: entry.action });
  }

  const row = (await db
    .prepare(`${BATTLE_COLUMNS} WHERE id = ? AND user_id = ?`)
    .bind(battleId, userId)
    .first()) as BattleRowFull | null;
  if (!row) throw new GameError('not_found', '전투를 찾을 수 없습니다.');
  // Repeat calls are answered from the settled row: one battle can only ever pay out once.
  if (row.result !== 'pending') return cachedSummary(row);
  if (Number(row.ruleset_version) !== BATTLE_RULESET_VERSION) {
    const summary = invalidSummary(row);
    await db
      .prepare("UPDATE battles SET result = 'invalid', summary = ?, completed_at = ? WHERE id = ? AND user_id = ? AND result = 'pending'")
      .bind(JSON.stringify(summary), now.toISOString(), battleId, userId)
      .run();
    return summary;
  }

  const setup = setupFromRow(row);
  const opponent = opponentById(row.opponent_id);
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
  const claims = await weeklyClaims(userId);
  const plan = planBattleRewards(
    {
      kind: row.kind === 'daily' ? 'daily' : 'pve',
      opponentId: row.opponent_id,
      result,
      kstDate: kst,
      firstClear: !claims.has(pveFirstClearClaimKey(row.opponent_id))
    },
    opponent.reward.credits
  );
  const progress = await achievementProgress(userId, {
    won: result === 'won',
    opponentId: row.opponent_id,
    kind: row.kind,
    cardIds: safeCards(row.deck_cards),
    clutch
  });
  const unlocked = evaluateAchievements(progress).filter((id) => !claims.has(achievementClaimKey(id)));
  const claimedAt = now.toISOString();
  const summary: BattleResultSummary = {
    result,
    // Only lines this settlement can actually pay: anything already claimed pays nothing, and a
    // summary must never advertise a reward the player did not receive.
    rewards: [
      ...plan.lines.filter((_line, index) => !claims.has(plan.claims[index]!)),
      ...unlocked.map((id) => ({
        label: `업적 · ${achievementById(id)?.name ?? id}`,
        credits: achievementById(id)?.reward ?? 0
      }))
    ],
    unlocked,
    mvpCardId: mvpCardId(simulation.state),
    rounds: simulation.state.round,
    damageDealt: damage
  };
  const nOnly = safeCards(row.deck_cards).every((id) => CARD_BY_ID.get(id)?.rarity === 'N') ? 1 : 0;

  try {
    await db.batch([
      // Settlement lock: exactly one request can ever insert this key, and because a D1 batch is
      // one transaction, a loser's whole payout rolls back instead of paying a second time.
      db.prepare('INSERT INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES (?, ?, 0, ?, ?)')
        .bind(userId, `settle:${battleId}`, battleId, claimedAt),
      db.prepare(`UPDATE battles SET result = ?, rounds = ?, damage_dealt = ?, clutch = ?, mvp_card_id = ?,
          n_only = ?, decisions = ?, summary = ?, completed_at = ?
        WHERE id = ? AND user_id = ? AND result = 'pending'`)
        .bind(result, simulation.state.round, damage, clutch ? 1 : 0, summary.mvpCardId, nOnly, JSON.stringify(verified), JSON.stringify(summary), claimedAt, battleId, userId),
      ...plan.claims.map((key) =>
        db.prepare('INSERT OR IGNORE INTO reward_claims (user_id, claim_key, credits, battle_id, claimed_at) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, key, plan.credits, battleId, claimedAt)
      ),
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
          SELECT COALESCE(SUM(credits), 0) FROM reward_claims
          WHERE user_id = ? AND battle_id = ? AND claimed_at = ?
        ) WHERE user_id = ?`)
        .bind(userId, battleId, claimedAt, userId)
    ]);
  } catch (error) {
    const settled = (await db
      .prepare(`${BATTLE_COLUMNS} WHERE id = ? AND user_id = ?`)
      .bind(battleId, userId)
      .first()) as BattleRowFull | null;
    // Another request settled this battle first (its claims rolled us back). Report what was
    // actually paid, read from the claim rows themselves rather than from a cached summary.
    if (settled && settled.result !== 'pending') return cachedSummary(settled);
    throw error;
  }
  return summary;
}

async function weeklyClaims(userId: string): Promise<Set<string>> {
  const db = getDatabase();
  const result = await db.prepare('SELECT claim_key FROM reward_claims WHERE user_id = ?').bind(userId).all();
  return new Set((result.results as Array<{ claim_key: string }>).map((row) => row.claim_key));
}

/** Cumulative achievement counters, including the battle that is finishing right now. */
async function achievementProgress(
  userId: string,
  pending: { won: boolean; opponentId: string; kind: string; cardIds: string[]; clutch: boolean }
): Promise<AchievementProgress> {
  const db = getDatabase();
  const [pullResult, inventoryResult] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total FROM pull_history WHERE user_id = ?').bind(userId),
    db.prepare('SELECT card_id FROM inventory WHERE user_id = ?').bind(userId)
  ]);
  const counters = await battleCounters(userId);
  const rarityById = new Map(cards.map((card) => [card.id, card.rarity] as const));
  const owned = inventoryResult.results as Array<{ card_id: string }>;
  const pulls = pullResult.results[0] as { total: number } | undefined;
  return {
    // The battle being settled is already stored as pending, so its win is not counted yet.
    wins: counters.wins + (pending.won ? 1 : 0),
    losses: counters.losses + (pending.won ? 0 : 1),
    bossClears: counters.bossClears + (pending.won && pending.opponentId === 'boss' ? 1 : 0),
    dailyClears: counters.dailyClears + (pending.won && pending.kind === 'daily' ? 1 : 0),
    nOnlyWins:
      counters.nOnlyWins +
      (pending.won && pending.cardIds.every((id) => rarityById.get(id) === 'N') ? 1 : 0),
    clutchWins: counters.clutchWins + (pending.won && pending.clutch ? 1 : 0),
    totalPulls: Number(pulls?.total ?? 0),
    ownedRarities: [...new Set(owned.map((row) => rarityById.get(row.card_id)).filter((value): value is Rarity => Boolean(value)))]
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
  const setup = setupFromRow(row);
  const opponent = opponentById(row.opponent_id);
  if (!setup || !opponent) throw new GameError('invalid_battle', '전투를 재현할 수 없습니다.');
  const decisions = parseDecisions(row.decisions);
  const simulation = runBattle(setup, decisions, (state) => aiDecision(state, opponent.profile));
  return {
    battleId: row.id,
    rulesetVersion: Number(row.ruleset_version),
    seed: Number(row.seed),
    kind: row.kind,
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
