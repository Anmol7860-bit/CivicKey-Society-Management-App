-- Owner/tenant moves onto the assignment: the same user may own one flat and rent another.
-- Existing links are backfilled from users.resident_type, which stays for the login response.
ALTER TABLE "flat_residents" ADD COLUMN "resident_type" "resident_type";--> statement-breakpoint
UPDATE "flat_residents" SET "resident_type" = coalesce((SELECT "resident_type" FROM "users" WHERE "users"."id" = "flat_residents"."user_id"), 'TENANT');--> statement-breakpoint
ALTER TABLE "flat_residents" ALTER COLUMN "resident_type" SET NOT NULL;--> statement-breakpoint

-- Co-owners/flatmates: max_occupants only applies while sharing is allowed
ALTER TABLE "flats" ADD COLUMN "sharing_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "max_occupants" integer;--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_sharing_capacity" CHECK (case when "flats"."sharing_allowed" then "flats"."max_occupants" is null or "flats"."max_occupants" >= 2 else "flats"."max_occupants" is null end);
