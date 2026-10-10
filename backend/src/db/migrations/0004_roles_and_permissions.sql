CREATE TYPE "public"."admin_permission" AS ENUM('SOCIETY_MANAGE', 'USER_MANAGE', 'GUARD_MANAGE', 'STAFF_MANAGE', 'AUDIT_VIEW', 'BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW');--> statement-breakpoint
CREATE TYPE "public"."resident_type" AS ENUM('OWNER', 'TENANT');--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"user_id" uuid NOT NULL,
	"permission" "admin_permission" NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permissions_user_id_permission_pk" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "resident_type" "resident_type";--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing residents predate the type; default them to OWNER so the check can be added
UPDATE "users" SET "resident_type" = 'OWNER' WHERE "role" = 'RESIDENT' AND "resident_type" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_resident_type_matches_role" CHECK (("users"."role" = 'RESIDENT' and "users"."resident_type" is not null) or ("users"."role" = 'GUARD' and "users"."resident_type" is null) or "users"."role" = 'ADMIN');