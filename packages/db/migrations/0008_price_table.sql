CREATE TABLE `price` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`medication_id` int unsigned NOT NULL,
	`transfer_id` int unsigned,
	`date` date NOT NULL,
	`package_size` smallint unsigned NOT NULL,
	`price_per_package` decimal(10,2) NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'SEK',
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `price_id` PRIMARY KEY(`id`),
	CONSTRAINT `price_transfer` UNIQUE(`transfer_id`),
	CONSTRAINT `price_package_size` CHECK(package_size > 0),
	CONSTRAINT `price_per_package` CHECK(price_per_package >= 0),
	CONSTRAINT `price_currency` CHECK(currency = 'SEK')
);
--> statement-breakpoint
ALTER TABLE `transfer` DROP CONSTRAINT `transfer_price`;--> statement-breakpoint
ALTER TABLE `price` ADD CONSTRAINT `price_medication` FOREIGN KEY (`medication_id`) REFERENCES `medication`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price` ADD CONSTRAINT `price_transfer_fk` FOREIGN KEY (`transfer_id`) REFERENCES `transfer`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price` ADD CONSTRAINT `price_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `price_medication_date` ON `price` (`medication_id`,`date`);--> statement-breakpoint
ALTER TABLE `medication` DROP COLUMN `package_price`;--> statement-breakpoint
ALTER TABLE `transfer` DROP COLUMN `price`;