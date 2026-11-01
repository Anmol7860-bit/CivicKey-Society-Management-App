ALTER TABLE "password_setup_codes" DROP CONSTRAINT "password_setup_codes_code_hash_unique";--> statement-breakpoint
ALTER TABLE "password_setup_codes" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The codes still live were hashed the old way and can no longer be matched, so retire them.
-- The office reissues one from the resident directory.
UPDATE "password_setup_codes" SET "used_at" = NOW() WHERE "used_at" IS NULL;
