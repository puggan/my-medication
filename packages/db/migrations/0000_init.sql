CREATE TABLE `dose` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`medication_id` int unsigned NOT NULL,
	`start_date` date NOT NULL,
	`per_day` decimal(8,2) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `dose_id` PRIMARY KEY(`id`),
	CONSTRAINT `dose_medication_start` UNIQUE(`medication_id`,`start_date`),
	CONSTRAINT `dose_per_day` CHECK(per_day >= 0)
);
--> statement-breakpoint
CREATE TABLE `medication` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`name` varchar(128) NOT NULL,
	`package_size` smallint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `medication_id` PRIMARY KEY(`id`),
	CONSTRAINT `medication_user_name` UNIQUE(`user_id`,`name`),
	CONSTRAINT `medication_package_size` CHECK(package_size > 0)
);
--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned,
	`credential_id` varbinary(1023) NOT NULL,
	`public_key` varbinary(1023) NOT NULL,
	`sign_count` int unsigned NOT NULL DEFAULT 0,
	`transports` json,
	`label` varchar(255) NOT NULL,
	`pairing_code` char(6) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`approved_at` datetime,
	`revoked_at` datetime,
	`last_used_at` datetime,
	CONSTRAINT `passkey_id` PRIMARY KEY(`id`),
	CONSTRAINT `passkey_credential` UNIQUE(`credential_id`),
	CONSTRAINT `passkey_approved_user` CHECK(approved_at IS NULL OR user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `stock_count` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`medication_id` int unsigned NOT NULL,
	`tier` tinyint unsigned NOT NULL,
	`counted_on` date NOT NULL,
	`tablets` decimal(8,2) NOT NULL,
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stock_count_id` PRIMARY KEY(`id`),
	CONSTRAINT `stock_count_tier` CHECK(tier BETWEEN 1 AND 3),
	CONSTRAINT `stock_count_tablets` CHECK(tablets >= 0)
);
--> statement-breakpoint
CREATE TABLE `transfer` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`medication_id` int unsigned NOT NULL,
	`kind` enum('renew','pickup','refill','drop') NOT NULL,
	`date` date NOT NULL,
	`tablets` decimal(8,2) NOT NULL,
	`tier` tinyint unsigned,
	`packages` smallint unsigned,
	`package_size` smallint unsigned,
	`note` varchar(255),
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime,
	CONSTRAINT `transfer_id` PRIMARY KEY(`id`),
	CONSTRAINT `transfer_drop_tier` CHECK((kind = 'drop') = (tier IS NOT NULL) AND (tier IS NULL OR tier BETWEEN 1 AND 3)),
	CONSTRAINT `transfer_tablets` CHECK(kind = 'drop' OR tablets > 0),
	CONSTRAINT `transfer_packages` CHECK((packages IS NULL) = (package_size IS NULL) AND (packages IS NULL OR kind = 'pickup'))
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`refill_anchor` date NOT NULL,
	`refill_interval_days` tinyint unsigned NOT NULL DEFAULT 14,
	`pickup_warning_days` tinyint unsigned NOT NULL DEFAULT 4,
	`renewal_lead_days` tinyint unsigned NOT NULL DEFAULT 30,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_name` UNIQUE(`name`)
);
--> statement-breakpoint
ALTER TABLE `dose` ADD CONSTRAINT `dose_medication` FOREIGN KEY (`medication_id`) REFERENCES `medication`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `medication` ADD CONSTRAINT `medication_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `passkey` ADD CONSTRAINT `passkey_user` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_medication` FOREIGN KEY (`medication_id`) REFERENCES `medication`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_medication` FOREIGN KEY (`medication_id`) REFERENCES `medication`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_created_by` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `passkey_pairing_code` ON `passkey` (`pairing_code`);--> statement-breakpoint
CREATE INDEX `stock_count_medication_date` ON `stock_count` (`medication_id`,`counted_on`);--> statement-breakpoint
CREATE INDEX `transfer_medication_date` ON `transfer` (`medication_id`,`date`);