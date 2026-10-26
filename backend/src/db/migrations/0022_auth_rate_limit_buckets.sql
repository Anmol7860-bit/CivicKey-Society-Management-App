CREATE TYPE "public"."rate_limit_bucket_type" AS ENUM('PHONE', 'IP');--> statement-breakpoint
CREATE TABLE "auth_rate_limit_buckets" (
	"bucket_key" char(64) PRIMARY KEY NOT NULL,
	"bucket_type" "rate_limit_bucket_type" NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_rate_limit_buckets_count_positive" CHECK ("auth_rate_limit_buckets"."request_count" >= 0)
);
