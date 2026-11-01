ALTER TABLE `passkey` ADD `requested_name` varchar(64) NOT NULL;--> statement-breakpoint
CREATE INDEX `passkey_requested_name` ON `passkey` (`requested_name`);