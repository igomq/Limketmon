ALTER TABLE `battles` ADD `mode` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `reward_claims` ADD `ticket_type` text;--> statement-breakpoint
ALTER TABLE `reward_claims` ADD `ticket_quantity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `sr_tickets` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `ssr_tickets` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_pull_history_user` ON `pull_history` (`user_id`);--> statement-breakpoint
-- Guards a ticket pull: an overdraft writes a negative balance and this aborts the whole batch, so
-- a short ticket balance can never leave granted cards behind (mirrors the pity guard).
CREATE TRIGGER `trg_user_game_state_ticket_guard`
BEFORE UPDATE OF `sr_tickets`, `ssr_tickets` ON `user_game_state`
WHEN NEW.`sr_tickets` < 0 OR NEW.`ssr_tickets` < 0
BEGIN
  SELECT RAISE(ROLLBACK, 'not_enough_tickets');
END;
