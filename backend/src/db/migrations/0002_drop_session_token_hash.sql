ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_refresh_token_hash_unique";--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP COLUMN "refresh_token_hash";