CREATE TABLE `coupon_redemptions` (
	`user_id` text NOT NULL,
	`coupon_code` text NOT NULL,
	`redeemed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `coupon_code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `inventory` (
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`first_obtained_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `card_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_inventory_quantity" CHECK("inventory"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `pull_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`rarity` text NOT NULL,
	`pulled_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_game_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`pull_credits` integer DEFAULT 0 NOT NULL,
	`last_free_pull_date` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_user_game_state_credits" CHECK("user_game_state"."pull_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);
--> statement-breakpoint
PRAGMA optimize;
