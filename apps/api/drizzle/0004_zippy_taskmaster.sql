CREATE TABLE IF NOT EXISTS "minor_guardian" (
	"user_id" text PRIMARY KEY NOT NULL,
	"guardian_name" text,
	"guardian_contact" text,
	"guardian_contact_type" text,
	"guardian_email" text,
	"guardian_phone" text,
	"guardian_ref" text,
	"guardian_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "consent_record_profile_creation_unique";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "domains" text[];--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "minor_guardian_guardian_ref_idx" ON "minor_guardian" USING btree ("guardian_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consent_record_profile_creation_unique" ON "consent_record" USING btree ("user_id","item_id","source") WHERE level = 'item' AND consent_category = 'profile_creation';
