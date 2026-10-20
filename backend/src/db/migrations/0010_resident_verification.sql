-- Verification moves onto the flat assignment: access follows a VERIFIED assignment, never a
-- verified mobile number. users.resident_type goes, since owner/tenant is per assignment.
CREATE TYPE "public"."id_document_type" AS ENUM('AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "verification_status" "verification_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "rejected_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "id_document_type" "id_document_type";--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "id_document_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "proof_reference" varchar(200);--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Links that predate verification are taken as verified by an Admin of their own society. Where the
-- society has no Admin the row stays PENDING and loses access, which is the safe side to fail on.
UPDATE "flat_residents" AS fr SET
  "verification_status" = 'VERIFIED',
  "verified_at" = now(),
  "verified_by" = v."admin_id"
FROM (
  SELECT fr2."id",
    (SELECT u."id" FROM "users" u
       JOIN "user_roles" ur ON ur."user_id" = u."id"
       JOIN "roles" r ON r."id" = ur."role_id"
      WHERE r."name" = 'ADMIN'
        AND u."society_id" = (SELECT b."society_id" FROM "flats" f JOIN "blocks" b ON b."id" = f."block_id" WHERE f."id" = fr2."flat_id")
      LIMIT 1) AS "admin_id"
    FROM "flat_residents" fr2
) AS v
WHERE v."id" = fr."id" AND v."admin_id" IS NOT NULL;--> statement-breakpoint

-- A tenancy must end on a date. No production data exists yet, so open-ended tenancies are closed
-- a year out rather than deleted; an Admin can correct the date.
UPDATE "flat_residents" SET "end_date" = current_date + interval '1 year' WHERE "resident_type" = 'TENANT' AND "end_date" IS NULL;--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN "resident_type";--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_tenant_end_date" CHECK ("flat_residents"."resident_type" <> 'TENANT' or "flat_residents"."end_date" is not null);--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_verified_fields" CHECK (("flat_residents"."verification_status" = 'VERIFIED') = ("flat_residents"."verified_at" is not null and "flat_residents"."verified_by" is not null));--> statement-breakpoint

-- One live assignment per person and flat. Overlapping periods are refused; a later, separate
-- tenancy for the same person is not. btree_gist is what lets uuid equality join a range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_no_overlap" EXCLUDE USING gist (
  "flat_id" WITH =,
  "user_id" WITH =,
  daterange("start_date", "end_date", '[]') WITH &&
) WHERE ("verification_status" <> 'REJECTED');
