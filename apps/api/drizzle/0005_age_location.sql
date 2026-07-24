ALTER TABLE "user" DROP COLUMN "date_of_birth";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "age" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "location" text;
