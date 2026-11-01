ALTER TABLE `medication` ADD `package_price` decimal(10,2);--> statement-breakpoint
ALTER TABLE `transfer` ADD `price` decimal(10,2);--> statement-breakpoint
ALTER TABLE `transfer` ADD `expires_on` date;--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_expires` CHECK ((kind = 'renew') = (expires_on IS NOT NULL));--> statement-breakpoint
ALTER TABLE `transfer` ADD CONSTRAINT `transfer_price` CHECK (price IS NULL OR kind = 'pickup');