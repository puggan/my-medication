CREATE TABLE `trust` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`giver_id` int unsigned NOT NULL,
	`trusted_id` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `trust_id` PRIMARY KEY(`id`),
	CONSTRAINT `trust_giver_trusted` UNIQUE(`giver_id`,`trusted_id`),
	CONSTRAINT `trust_not_self` CHECK(giver_id <> trusted_id)
);
--> statement-breakpoint
ALTER TABLE `medication` ADD `unit` enum('tablet','E','piece') DEFAULT 'tablet' NOT NULL;--> statement-breakpoint
ALTER TABLE `medication` ADD `open_size` smallint unsigned;--> statement-breakpoint
ALTER TABLE `medication` ADD `usage` varchar(255);--> statement-breakpoint
ALTER TABLE `medication` ADD `storage` varchar(64);--> statement-breakpoint
ALTER TABLE `organizer` ADD `kind` enum('slots','open') DEFAULT 'slots' NOT NULL;--> statement-breakpoint
ALTER TABLE `trust` ADD CONSTRAINT `trust_giver` FOREIGN KEY (`giver_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trust` ADD CONSTRAINT `trust_trusted` FOREIGN KEY (`trusted_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `medication` ADD CONSTRAINT `medication_open_size` CHECK (open_size IS NULL OR (open_size > 0 AND open_size <= package_size));