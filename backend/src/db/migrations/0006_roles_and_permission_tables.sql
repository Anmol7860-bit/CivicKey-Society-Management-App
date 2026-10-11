CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_role_permissions_permission_id" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint

-- Master data. Codes must match modules/access/permissions.ts
INSERT INTO "roles" ("name") VALUES ('ADMIN'), ('RESIDENT'), ('GUARD') ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "permissions" ("code", "description") VALUES
	('SOCIETY_MANAGE', 'Manage society, blocks and flats'),
	('USER_MANAGE', 'Manage users and resident links'),
	('GUARD_MANAGE', 'Manage guards'),
	('STAFF_MANAGE', 'Register staff and issue staff passes'),
	('AUDIT_VIEW', 'View audit logs'),
	('BILLING_RATE_SET', 'Set billing rates'),
	('INVOICE_GENERATE', 'Generate invoices and one-time charges'),
	('PAYMENT_CASH_MARK', 'Mark cash payments'),
	('REPORT_VIEW', 'View operational and billing reports'),
	('VISIT_REGISTER', 'Register visitors'),
	('VISIT_DECIDE', 'Allow or deny visitor entry'),
	('VISIT_ENTRY_RECORD', 'Record visitor entry'),
	('VISIT_EXIT', 'Record visitor exit'),
	('PASS_VALIDATE', 'Validate visitor or staff pass'),
	('VISITOR_APPROVE', 'Approve or deny own-flat visitors'),
	('VISITOR_PASS_CREATE', 'Create visitor pass for own flat'),
	('VISIT_VIEW_OWN', 'View own-flat visits'),
	('BILL_VIEW_OWN', 'View own bills'),
	('BILL_PAY', 'Pay own bill'),
	('RECEIPT_VIEW_OWN', 'View own receipts')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON
	(r."name" = 'GUARD' AND p."code" IN ('VISIT_REGISTER', 'VISIT_DECIDE', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'PASS_VALIDATE'))
	OR (r."name" = 'RESIDENT' AND p."code" IN ('VISITOR_APPROVE', 'VISITOR_PASS_CREATE', 'VISIT_VIEW_OWN', 'BILL_VIEW_OWN', 'BILL_PAY', 'RECEIPT_VIEW_OWN'))
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- users.role moves to user_roles
INSERT INTO "user_roles" ("user_id", "role_id") SELECT u."id", r."id" FROM "users" u JOIN "roles" r ON r."name" = u."role";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_resident_type_matches_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint

-- user_permissions: enum column -> permissions FK, with grant/revoke times
ALTER TABLE "user_permissions" DROP CONSTRAINT "user_permissions_user_id_permission_pk";--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "permission_id" uuid;--> statement-breakpoint
UPDATE "user_permissions" up SET "permission_id" = p."id" FROM "permissions" p WHERE p."code" = up."permission"::text;--> statement-breakpoint
ALTER TABLE "user_permissions" ALTER COLUMN "permission_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" DROP COLUMN "permission";--> statement-breakpoint
-- Grants made before granted_by was required have no granter; record the holder rather than lose the grant
UPDATE "user_permissions" SET "granted_by" = "user_id" WHERE "granted_by" IS NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" DROP CONSTRAINT "user_permissions_granted_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_permissions" ALTER COLUMN "granted_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" RENAME COLUMN "created_at" TO "granted_at";--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_permission_id_pk" PRIMARY KEY("user_id","permission_id");--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."admin_permission";--> statement-breakpoint

-- flat_residents: LLD column names; renaming keeps existing links and the check constraint
ALTER TABLE "flat_residents" RENAME COLUMN "access" TO "access_level";--> statement-breakpoint
ALTER TABLE "flat_residents" RENAME COLUMN "valid_from" TO "start_date";--> statement-breakpoint
ALTER TABLE "flat_residents" RENAME COLUMN "valid_to" TO "end_date";
