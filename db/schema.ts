import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    lastFreePullDate: text('last_free_pull_date')
  },
  (table) => [check('chk_user_game_state_credits', sql`${table.pullCredits} >= 0`)]
);

export const inventory = sqliteTable(
  'inventory',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    firstObtainedAt: text('first_obtained_at').notNull()
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

export const pullHistory = sqliteTable('pull_history', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull(),
  rarity: text('rarity').notNull(),
  pulledAt: text('pulled_at').notNull()
});
