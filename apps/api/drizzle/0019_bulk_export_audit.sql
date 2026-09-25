CREATE TABLE "bulk_export_audit" (
	"export_id" uuid PRIMARY KEY NOT NULL,
	"requester_user_id" text NOT NULL,
	"requester_item_id" uuid,
	"filters" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"format" text NOT NULL,
	"row_count" integer NOT NULL,
	"revealed_count" integer NOT NULL,
	"masked_count" integer NOT NULL,
	"skipped_cross_instance" integer NOT NULL,
	"skipped_missing" integer NOT NULL,
	"skipped_self" integer NOT NULL,
	"skipped_not_enabled" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bulk_export_audit_requester_idx" ON "bulk_export_audit" USING btree ("requester_user_id","created_at");