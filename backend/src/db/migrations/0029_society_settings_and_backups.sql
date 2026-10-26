CREATE TYPE "public"."backup_export_status" AS ENUM('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "backup_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" "backup_export_status" DEFAULT 'PENDING' NOT NULL,
	"file_name" varchar(120),
	"byte_size" integer,
	"downloaded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "society_settings" (
	"society_id" uuid PRIMARY KEY NOT NULL,
	"timezone" varchar(80) DEFAULT 'Asia/Kolkata' NOT NULL,
	"id_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_export_jobs" ADD CONSTRAINT "backup_export_jobs_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_export_jobs" ADD CONSTRAINT "backup_export_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_settings" ADD CONSTRAINT "society_settings_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_export_jobs_requested_by_idx" ON "backup_export_jobs" USING btree ("requested_by","created_at" DESC NULLS LAST);
-- Master data: the permission that allows an encrypted local backup to be exported.
-- Codes must match modules/access/permissions.ts
INSERT INTO "permissions" ("code", "description") VALUES
	('BACKUP_EXPORT', 'Export an encrypted local database backup')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- Every society already in the database gets the settings row the code now expects
INSERT INTO "society_settings" ("society_id") SELECT "id" FROM "societies" ON CONFLICT DO NOTHING;
