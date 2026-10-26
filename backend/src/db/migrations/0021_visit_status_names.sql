-- The persisted visit statuses take the names the design baseline fixes. Renaming the enum values
-- keeps every existing row: a visit that was INSIDE is the same visit, now called ENTERED.
ALTER TYPE "public"."visit_status" RENAME VALUE 'WAITING' TO 'AWAITING_APPROVAL';--> statement-breakpoint
ALTER TYPE "public"."visit_status" RENAME VALUE 'INSIDE' TO 'ENTERED';--> statement-breakpoint
ALTER TYPE "public"."visit_status" RENAME VALUE 'LEFT' TO 'CLOSED';--> statement-breakpoint
-- A visit nobody answered within 180 seconds waits here for the guard to decide at the gate.
ALTER TYPE "public"."visit_status" ADD VALUE IF NOT EXISTS 'AWAITING_MANUAL' AFTER 'AWAITING_APPROVAL';--> statement-breakpoint
ALTER TABLE "visits" ALTER COLUMN "status" SET DEFAULT 'AWAITING_APPROVAL';--> statement-breakpoint
-- The guard decision check named the old status.
ALTER TABLE "visits" DROP CONSTRAINT IF EXISTS "visits_decision_recorded";--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_decision_recorded" CHECK ("decided_at" is null or "status" <> 'AWAITING_APPROVAL');
