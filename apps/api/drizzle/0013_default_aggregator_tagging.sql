CREATE TABLE "aggregator_default_audit" (
	"change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding" text NOT NULL,
	"from_org_id" text,
	"to_org_id" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_reassignment_audit" (
	"reassignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"from_org_id" text,
	"to_org_id" text NOT NULL,
	"binding" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_for_bindings" text[];--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "onboarded_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "aggregator_default_audit_binding_idx" ON "aggregator_default_audit" USING btree ("binding","changed_at");--> statement-breakpoint
CREATE INDEX "aggregator_default_audit_to_org_idx" ON "aggregator_default_audit" USING btree ("to_org_id","changed_at");--> statement-breakpoint
CREATE INDEX "participant_reassignment_audit_user_idx" ON "participant_reassignment_audit" USING btree ("user_id","changed_at");--> statement-breakpoint
CREATE INDEX "participant_reassignment_audit_from_idx" ON "participant_reassignment_audit" USING btree ("from_org_id","changed_at");--> statement-breakpoint
CREATE INDEX "participant_reassignment_audit_to_idx" ON "participant_reassignment_audit" USING btree ("to_org_id","changed_at");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_requires_aggregator" CHECK ("organization"."default_for_bindings" IS NULL OR "organization"."type" = 'aggregator');