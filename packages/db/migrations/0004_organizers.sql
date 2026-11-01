CREATE TABLE `organizer` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`name` varchar(32) NOT NULL,
	`containers` tinyint unsigned NOT NULL DEFAULT 1,
	`container_days` tinyint unsigned NOT NULL DEFAULT 7,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `organizer_id` PRIMARY KEY(`id`),
	CONSTRAINT `organizer_user_name` UNIQUE(`user_id`,`name`),
	CONSTRAINT `organizer_size` CHECK(containers > 0 AND container_days > 0)
);
--> statement-breakpoint
ALTER TABLE `organizer` ADD CONSTRAINT `organizer_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing doses and tier 1 stock move to a two-week morning organizer, which is what tier 1 was so far
INSERT INTO `organizer` (`user_id`, `name`, `containers`) SELECT `id`, 'morning', 2 FROM `user`;--> statement-breakpoint
ALTER TABLE `dose` ADD `organizer_id` int unsigned;--> statement-breakpoint
ALTER TABLE `stock_count` ADD `organizer_id` int unsigned;--> statement-breakpoint
ALTER TABLE `transfer` ADD `organizer_id` int unsigned;--> statement-breakpoint
UPDATE `dose` JOIN `medication` ON `medication`.`id` = `dose`.`medication_id` JOIN `organizer` ON `organizer`.`user_id` = `medication`.`user_id` AND `organizer`.`name` = 'morning' SET `dose`.`organizer_id` = `organizer`.`id`;--> statement-breakpoint
UPDATE `stock_count` JOIN `medication` ON `medication`.`id` = `stock_count`.`medication_id` JOIN `organizer` ON `organizer`.`user_id` = `medication`.`user_id` AND `organizer`.`name` = 'morning' SET `stock_count`.`organizer_id` = `organizer`.`id` WHERE `stock_count`.`tier` = 1;--> statement-breakpoint
UPDATE `transfer` JOIN `medication` ON `medication`.`id` = `transfer`.`medication_id` JOIN `organizer` ON `organizer`.`user_id` = `medication`.`user_id` AND `organizer`.`name` = 'morning' SET `transfer`.`organizer_id` = `organizer`.`id` WHERE `transfer`.`kind` = 'refill' OR `transfer`.`tier` = 1;--> statement-breakpoint
ALTER TABLE `dose` MODIFY `organizer_id` int unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `dose` ADD CONSTRAINT `dose_medication_organizer_start` UNIQUE(`medication_id`,`organizer_id`,`start_date`);--> statement-breakpoint
ALTER TABLE `dose` DROP INDEX `dose_medication_start`;--> statement-breakpoint
ALTER TABLE `stock_count` DROP CONSTRAINT `stock_count_tier`;--> statement-breakpoint
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_tier` CHECK (tier BETWEEN 1 AND 3 AND (tier = 1) = (organizer_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_organizer_tier` CHECK ((organizer_id IS NOT NULL) = (kind = 'refill' OR tier = 1));--> statement-breakpoint
ALTER TABLE `dose` ADD CONSTRAINT `dose_organizer` FOREIGN KEY (`organizer_id`) REFERENCES `organizer`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_organizer` FOREIGN KEY (`organizer_id`) REFERENCES `organizer`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_organizer` FOREIGN KEY (`organizer_id`) REFERENCES `organizer`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user` DROP COLUMN `organizer_days`;
