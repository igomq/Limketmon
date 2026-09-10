CREATE TABLE `battles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'pve' NOT NULL,
	`opponent_id` text NOT NULL,
	`deck_id` text,
	`ruleset_version` integer NOT NULL,
	`seed` integer NOT NULL,
	`deck_cards` text NOT NULL,
	`modifier` text DEFAULT '{"kind":"none"}' NOT NULL,
	`decisions` text DEFAULT '[]' NOT NULL,
	`result` text DEFAULT 'pending' NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`damage_dealt` integer DEFAULT 0 NOT NULL,
	`clutch` integer DEFAULT 0 NOT NULL,
	`n_only` integer DEFAULT 0 NOT NULL,
	`mvp_card_id` text,
	`summary` text,
	`kst_date` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_battles_result" CHECK("battles"."result" in ('pending', 'won', 'lost', 'draw', 'invalid'))
);
--> statement-breakpoint
CREATE INDEX `idx_battles_user_created` ON `battles` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_battles_user_kind_date` ON `battles` (`user_id`,`kind`,`kst_date`);--> statement-breakpoint
CREATE TABLE `deck_cards` (
	`deck_id` text NOT NULL,
	`slot` integer NOT NULL,
	`card_id` text NOT NULL,
	PRIMARY KEY(`deck_id`, `slot`),
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_deck_cards_slot" CHECK("deck_cards"."slot" >= 0 and "deck_cards"."slot" < 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_deck_cards_unique` ON `deck_cards` (`deck_id`,`card_id`);--> statement-breakpoint
CREATE TABLE `decks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_decks_is_default" CHECK("decks"."is_default" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_decks_user_name` ON `decks` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `reward_claims` (
	`user_id` text NOT NULL,
	`claim_key` text NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`battle_id` text,
	`claimed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `claim_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_achievements` (
	`user_id` text NOT NULL,
	`achievement_id` text NOT NULL,
	`unlocked_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `achievement_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `pity_counter` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Guards the pull transaction: a pull whose roll used a stale pity counter writes -1, and this
-- aborts the whole batch so nothing is granted for a discarded roll.
CREATE TRIGGER `trg_user_game_state_pity_guard`
BEFORE UPDATE OF `pity_counter` ON `user_game_state`
WHEN NEW.`pity_counter` < 0
BEGIN
  SELECT RAISE(ROLLBACK, 'pity_changed');
END;
