CREATE TYPE "public"."gender" AS ENUM('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');--> statement-breakpoint
ALTER TABLE "flat_residents" ADD COLUMN "relationship" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" "gender";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_language" varchar(8);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "alternate_phone" varchar(15);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "emergency_contact_name" varchar(120);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "emergency_contact_relationship" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "emergency_contact_phone" varchar(15);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_language_supported" CHECK ("users"."preferred_language" is null or "users"."preferred_language" in ('en', 'hi', 'mr'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_emergency_contact_not_self" CHECK ("users"."emergency_contact_phone" is null or "users"."emergency_contact_phone" <> "users"."phone");