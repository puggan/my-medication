CREATE TABLE `calendar_feed` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`passkey_id` int unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_fetched_at` datetime,
	`revoked_at` datetime,
	CONSTRAINT `calendar_feed_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_feed_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `calendar_feed` ADD CONSTRAINT `calendar_feed_passkey` FOREIGN KEY (`passkey_id`) REFERENCES `passkey`(`id`) ON DELETE no action ON UPDATE no action;