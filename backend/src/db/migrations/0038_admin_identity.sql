ALTER TABLE "users" ADD COLUMN "id_document_type" "id_document_type";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_document_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_document_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_document_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_document_hash_hmac" CHECK ("users"."id_document_hash" is null or "users"."id_document_hash" ~ '^[0-9a-f]{64}$');