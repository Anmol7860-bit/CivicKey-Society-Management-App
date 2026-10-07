ALTER TABLE "auth_sessions" ADD COLUMN "device_id" varchar(128);--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_active_idx" ON "auth_sessions" USING btree ("user_id","expires_at") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_token_hash_sha256" CHECK ("refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$');