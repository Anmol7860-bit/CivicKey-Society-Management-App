ALTER TYPE "public"."visit_purpose" ADD VALUE 'FOOD_DELIVERY';--> statement-breakpoint
ALTER TYPE "public"."visit_purpose" ADD VALUE 'DOMESTIC_HELP';--> statement-breakpoint
ALTER TYPE "public"."visit_purpose" ADD VALUE 'MAINTENANCE';--> statement-breakpoint
ALTER TYPE "public"."visit_purpose" ADD VALUE 'BUSINESS';--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "visitor_approval_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "society_settings" ADD COLUMN "visitor_purposes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "society_settings" ADD COLUMN "leave_at_gate_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
--> The gate used to ask whoever held full access, so that is what every existing assignment keeps
UPDATE "flat_residents" SET "visitor_approval_eligible" = ("access_level" = 'FULL');
