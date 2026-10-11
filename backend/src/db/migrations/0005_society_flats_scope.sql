CREATE TYPE "public"."flat_access" AS ENUM('FULL', 'VIEW_ONLY');--> statement-breakpoint
CREATE TABLE "flat_residents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access" "flat_access" DEFAULT 'FULL' NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flat_residents_valid_period" CHECK ("flat_residents"."valid_to" is null or "flat_residents"."valid_to" >= "flat_residents"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "flats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"block" varchar(32) NOT NULL,
	"number" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flats_society_block_number_unique" UNIQUE("society_id","block","number")
);
--> statement-breakpoint
CREATE TABLE "societies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flat_residents_user_id_flat_id_idx" ON "flat_residents" USING btree ("user_id","flat_id");--> statement-breakpoint
-- Users created before societies existed keep their society id; give each id a society row
INSERT INTO "societies" ("id", "name") SELECT DISTINCT "society_id", 'Unnamed society' FROM "users" WHERE "society_id" IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;