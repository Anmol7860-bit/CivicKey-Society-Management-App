-- Identity is kept as type + keyed hash + last 4 digits; the full number is never stored.
ALTER TABLE "flat_residents" ADD COLUMN "id_document_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "flat_residents" ADD CONSTRAINT "flat_residents_id_document_hash_sha256" CHECK ("flat_residents"."id_document_hash" is null or "flat_residents"."id_document_hash" ~ '^[0-9a-f]{64}$');