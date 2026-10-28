CREATE TYPE "public"."visit_rejection_reason" AS ENUM('APPROVAL_NOT_RECEIVED', 'DETAILS_MISMATCH', 'VERIFICATION_FAILED', 'INVALID_PASS', 'SECURITY_CONCERN', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."visit_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."visit_status" ADD VALUE 'REJECTED_AT_GATE';--> statement-breakpoint
ALTER TABLE "society_settings" ADD COLUMN "visit_validity_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "rejection_reason" "visit_rejection_reason";--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "cancellation_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_cancellation_recorded" CHECK (("visits"."cancelled_at" is null) = ("visits"."cancelled_by" is null));