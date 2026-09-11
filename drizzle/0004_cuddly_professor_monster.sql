ALTER TABLE `inventory` ADD `base_card_id` text;--> statement-breakpoint
ALTER TABLE `inventory` ADD `rarity_override` text;--> statement-breakpoint
ALTER TABLE `inventory` ADD `traits` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `low_tickets` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `proof` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `fragments` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_game_state` ADD `twin_proof` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER trg_progression_balances BEFORE UPDATE ON user_game_state
WHEN NEW.proof < 0 OR NEW.fragments < 0 OR NEW.twin_proof < 0
BEGIN SELECT RAISE(ROLLBACK, 'not_enough_materials'); END;
--> statement-breakpoint
CREATE TRIGGER trg_owned_deck_insert BEFORE INSERT ON deck_cards
WHEN NOT EXISTS (SELECT 1 FROM inventory i JOIN decks d ON d.user_id = i.user_id WHERE d.id = NEW.deck_id AND i.card_id = NEW.card_id)
OR EXISTS (SELECT 1 FROM deck_cards c JOIN decks d ON d.id = c.deck_id
JOIN inventory old ON old.user_id = d.user_id AND old.card_id = c.card_id
JOIN inventory incoming ON incoming.user_id = d.user_id AND incoming.card_id = NEW.card_id
WHERE c.deck_id = NEW.deck_id AND COALESCE(old.base_card_id, old.card_id) = COALESCE(incoming.base_card_id, incoming.card_id))
BEGIN SELECT RAISE(ROLLBACK, 'invalid_owned_deck'); END;
--> statement-breakpoint
CREATE TRIGGER trg_inventory_deck_delete BEFORE DELETE ON inventory
WHEN EXISTS (SELECT 1 FROM deck_cards c JOIN decks d ON d.id = c.deck_id WHERE d.user_id = OLD.user_id AND c.card_id = OLD.card_id)
BEGIN SELECT RAISE(ROLLBACK, 'card_in_deck'); END;

--> statement-breakpoint
CREATE TRIGGER trg_low_ticket_balance BEFORE UPDATE OF low_tickets ON user_game_state
WHEN NEW.low_tickets < 0
BEGIN SELECT RAISE(ROLLBACK, 'not_enough_tickets'); END;
--> statement-breakpoint
CREATE TRIGGER trg_owned_deck_update BEFORE UPDATE OF card_id ON deck_cards
WHEN NOT EXISTS (SELECT 1 FROM inventory i JOIN decks d ON d.user_id = i.user_id WHERE d.id = NEW.deck_id AND i.card_id = NEW.card_id)
OR EXISTS (SELECT 1 FROM deck_cards c JOIN decks d ON d.id = c.deck_id
JOIN inventory previous ON previous.user_id = d.user_id AND previous.card_id = c.card_id
JOIN inventory incoming ON incoming.user_id = d.user_id AND incoming.card_id = NEW.card_id
WHERE c.deck_id = NEW.deck_id AND c.slot != OLD.slot
AND COALESCE(previous.base_card_id, previous.card_id) = COALESCE(incoming.base_card_id, incoming.card_id))
BEGIN SELECT RAISE(ROLLBACK, 'invalid_owned_deck'); END;

--> statement-breakpoint
-- UPDATE guards cannot reject invalid balances supplied when an account row is inserted.
CREATE TRIGGER trg_progression_balances_insert BEFORE INSERT ON user_game_state
WHEN NEW.proof < 0 OR NEW.fragments < 0 OR NEW.twin_proof < 0
BEGIN SELECT RAISE(ROLLBACK, 'not_enough_materials'); END;
--> statement-breakpoint
CREATE TRIGGER trg_ticket_balances_insert BEFORE INSERT ON user_game_state
WHEN NEW.low_tickets < 0 OR NEW.sr_tickets < 0 OR NEW.ssr_tickets < 0
BEGIN SELECT RAISE(ROLLBACK, 'not_enough_tickets'); END;
