ALTER TABLE `user` ADD `refill_weekday` tinyint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `organizer_days` tinyint unsigned DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD CONSTRAINT `user_refill_weekday` CHECK (refill_weekday BETWEEN 0 AND 6);