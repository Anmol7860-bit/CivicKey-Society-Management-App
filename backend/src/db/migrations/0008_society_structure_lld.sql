-- Aligns the society structure with the database LLD. Renames and backfills keep existing data;
-- flat ids and flat_residents links are untouched.
CREATE TYPE "public"."record_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint

-- is_active → status
ALTER TABLE "blocks" ADD COLUMN "status" "record_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "status" "record_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "status" "record_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
UPDATE "blocks" SET "status" = 'INACTIVE' WHERE NOT "is_active";--> statement-breakpoint
UPDATE "floors" SET "status" = 'INACTIVE' WHERE NOT "is_active";--> statement-breakpoint
UPDATE "flats" SET "status" = 'INACTIVE' WHERE NOT "is_active";--> statement-breakpoint
ALTER TABLE "blocks" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "floors" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "flats" DROP COLUMN "is_active";--> statement-breakpoint

-- floors.label → floor_label (max 80), display_order → sort_order. Postgres carries the rename
-- into floors_block_id_label_unique and floors_label_normalized.
ALTER TABLE "floors" RENAME COLUMN "label" TO "floor_label";--> statement-breakpoint
ALTER TABLE "floors" ALTER COLUMN "floor_label" SET DATA TYPE varchar(80);--> statement-breakpoint
ALTER TABLE "floors" RENAME COLUMN "display_order" TO "sort_order";--> statement-breakpoint

-- A flat's society is now resolved through floor → block → society
ALTER TABLE "flats" DROP CONSTRAINT "flats_block_id_society_id_blocks_fk";--> statement-breakpoint
ALTER TABLE "flats" DROP CONSTRAINT "flats_society_id_societies_id_fk";--> statement-breakpoint
ALTER TABLE "flats" DROP COLUMN "society_id";--> statement-breakpoint
ALTER TABLE "blocks" DROP CONSTRAINT "blocks_id_society_id_unique";--> statement-breakpoint

-- Deleting a flat or user no longer cascades into resident assignments
ALTER TABLE "flat_residents" DROP CONSTRAINT "flat_residents_flat_id_flats_id_fk";--> statement-breakpoint
ALTER TABLE "flat_residents" DROP CONSTRAINT "flat_residents_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flat_residents_flat_id_idx" ON "flat_residents" USING btree ("flat_id");
