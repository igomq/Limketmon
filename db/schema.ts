import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [uniqueIndex('idx_users_email').on(table.email)]
);

export const userGameState = sqliteTable(
  'user_game_state',
  {
    userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    pullCredits: integer('pull_credits').notNull().default(0),
    lastFreePullDate: text('last_free_pull_date'),
    // Consecutive pulls since the last SSR-or-better. Drives soft and hard pity.
    pityCounter: integer('pity_counter').notNull().default(0),
    // Guaranteed-pull tickets. Distinct balances: a ticket pull can never spend normal credits.
    srTickets: integer('sr_tickets').notNull().default(0),
    ssrTickets: integer('ssr_tickets').notNull().default(0),
    lowTickets: integer('low_tickets').notNull().default(0),
    proof: integer('proof').notNull().default(0),
    fragments: integer('fragments').notNull().default(0),
    twinProof: integer('twin_proof').notNull().default(0)
  },
  (table) => [
    check('chk_user_game_state_credits', sql`${table.pullCredits} >= 0`)
  ]
);

export const inventory = sqliteTable(
  'inventory',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    firstObtainedAt: text('first_obtained_at').notNull(),
    enhanceLevel: integer('enhance_level').notNull().default(0),
    baseCardId: text('base_card_id'),
    rarityOverride: text('rarity_override'),
    traits: text('traits').notNull().default('[]')
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.cardId] }),
    check('chk_inventory_quantity', sql`${table.quantity} > 0`)
  ]
);

export const couponRedemptions = sqliteTable(
  'coupon_redemptions',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    couponCode: text('coupon_code').notNull(),
    redeemedAt: text('redeemed_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.couponCode] })]
);

export const pullHistory = sqliteTable(
  'pull_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    rarity: text('rarity').notNull(),
    pulledAt: text('pulled_at').notNull()
  },
  // Every read filters by user first (count + per-rarity totals), so the index is on user_id.
  (table) => [index('idx_pull_history_user').on(table.userId)]
);

export const decks = sqliteTable(
  'decks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: integer('is_default').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_decks_user_name').on(table.userId, table.name),
    check('chk_decks_is_default', sql`${table.isDefault} in (0, 1)`)
  ]
);

export const deckCards = sqliteTable(
  'deck_cards',
  {
    deckId: text('deck_id').notNull().references(() => decks.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    cardId: text('card_id').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.deckId, table.slot] }),
    uniqueIndex('idx_deck_cards_unique').on(table.deckId, table.cardId),
    check('chk_deck_cards_slot', sql`${table.slot} >= 0 and ${table.slot} < 3`)
  ]
);

// One row per battle. The server re-simulates from seed + deck_cards + decisions, so the stored
// result is only ever a cache of the verified outcome.
export const battles = sqliteTable(
  'battles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('pve'),
    // Difficulty mode the battle was started under. Replay/finish re-derive the opponent from it.
    mode: text('mode').notNull().default('normal'),
    opponentId: text('opponent_id').notNull(),
    deckId: text('deck_id'),
    rulesetVersion: integer('ruleset_version').notNull(),
    seed: integer('seed').notNull(),
    deckCards: text('deck_cards').notNull(),
    modifier: text('modifier').notNull().default('{"kind":"none"}'),
    decisions: text('decisions').notNull().default('[]'),
    result: text('result').notNull().default('pending'),
    rounds: integer('rounds').notNull().default(0),
    damageDealt: integer('damage_dealt').notNull().default(0),
    /** 1 when a surviving ally ended the battle at or below 10% HP. */
    clutch: integer('clutch').notNull().default(0),
    /** 1 when the deployed deck was entirely N rarity; counted by the achievement query. */
    nOnly: integer('n_only').notNull().default(0),
    mvpCardId: text('mvp_card_id'),
    /** Cached BattleResultSummary JSON, so a repeated finish request returns the same answer. */
    summary: text('summary'),
    kstDate: text('kst_date').notNull(),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at')
  },
  (table) => [
    index('idx_battles_user_created').on(table.userId, table.createdAt),
    index('idx_battles_user_kind_date').on(table.userId, table.kind, table.kstDate),
    check('chk_battles_result', sql`${table.result} in ('pending', 'won', 'lost', 'draw', 'invalid')`)
  ]
);

export const userAchievements = sqliteTable(
  'user_achievements',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id').notNull(),
    unlockedAt: text('unlocked_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.achievementId] })]
);

// Idempotency gate for every one-off payout (first clears, daily challenge, achievements).
// The primary key makes a duplicate claim abort the surrounding D1 batch.
export const rewardClaims = sqliteTable(
  'reward_claims',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    claimKey: text('claim_key').notNull(),
    credits: integer('credits').notNull().default(0),
    // Ticket payouts ride the same idempotency gate: one claim row, credits 0, ticket_type set.
    ticketType: text('ticket_type'),
    ticketQuantity: integer('ticket_quantity').notNull().default(0),
    battleId: text('battle_id'),
    claimedAt: text('claimed_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.claimKey] })]
);
