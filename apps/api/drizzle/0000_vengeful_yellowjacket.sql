CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" text,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"team_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"team_id" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	"type" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"role" text,
	"banned" boolean,
	"ban_reason" text,
	"ban_expires" timestamp,
	"phone_number" text,
	"phone_number_verified" boolean,
	"date_of_birth" timestamp,
	"terms_accepted" boolean DEFAULT false,
	"privacy_accepted" boolean DEFAULT false,
	"onboarded_by_org_id" text,
	"onboarded_via" text,
	"onboarded_source_id" text,
	"onboarded_at" timestamp,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"level" text NOT NULL,
	"consent_category" text NOT NULL,
	"action_type" text,
	"action_stage" text,
	"user_id" text NOT NULL,
	"item_id" uuid,
	"action_id" uuid,
	"network" text NOT NULL,
	"brand" text,
	"document_version" integer NOT NULL,
	"source" text NOT NULL,
	"accepted_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "item_metrics" (
	"item_id" text PRIMARY KEY NOT NULL,
	"item_network" text NOT NULL,
	"item_domain" text NOT NULL,
	"item_type" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"onboarded_by_org_id" text,
	"onboarded_via" text,
	"display_name" text NOT NULL,
	"profile_status" text,
	"profile_completion_pct" integer,
	"profile_created_at" timestamp,
	"profile_last_updated_at" timestamp,
	"age_days" integer,
	"initiated" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_initiated_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_received_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actionable_tags" text[],
	"last_computed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii_reveal_audit" (
	"reveal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"viewer_user_id" text NOT NULL,
	"revealed_item_id" uuid NOT NULL,
	"revealed_item_owner" text NOT NULL,
	"revealed_action_type" text NOT NULL,
	"revealed_action_status_at_view" text NOT NULL,
	"viewed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_onboarded_by_org_id_organization_id_fk" FOREIGN KEY ("onboarded_by_org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_metrics" ADD CONSTRAINT "item_metrics_onboarded_by_org_id_organization_id_fk" FOREIGN KEY ("onboarded_by_org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_onboarded_by_org_via_idx" ON "user" USING btree ("onboarded_by_org_id","onboarded_via");--> statement-breakpoint
CREATE INDEX "user_tags_gin_idx" ON "user" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "consent_record_user_idx" ON "consent_record" USING btree ("user_id","consent_category","action_type","action_stage","seq");--> statement-breakpoint
CREATE INDEX "consent_record_item_idx" ON "consent_record" USING btree ("item_id","consent_category");--> statement-breakpoint
CREATE INDEX "consent_record_action_idx" ON "consent_record" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_record_profile_creation_unique" ON "consent_record" USING btree ("user_id","item_id") WHERE level = 'item' AND consent_category = 'profile_creation';--> statement-breakpoint
CREATE INDEX "item_metrics_org_domain_status_idx" ON "item_metrics" USING btree ("onboarded_by_org_id","item_domain","profile_status");--> statement-breakpoint
CREATE INDEX "item_metrics_org_domain_last_computed_idx" ON "item_metrics" USING btree ("onboarded_by_org_id","item_domain","last_computed_at");--> statement-breakpoint
CREATE INDEX "item_metrics_owner_domain_idx" ON "item_metrics" USING btree ("owner_user_id","item_domain");--> statement-breakpoint
CREATE INDEX "pii_reveal_audit_viewer_idx" ON "pii_reveal_audit" USING btree ("viewer_user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "pii_reveal_audit_item_idx" ON "pii_reveal_audit" USING btree ("revealed_item_id","viewed_at");