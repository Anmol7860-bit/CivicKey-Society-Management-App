CREATE TABLE "password_setup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_setup_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "password_setup_codes_code_hash_sha256" CHECK ("password_setup_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "password_setup_codes" ADD CONSTRAINT "password_setup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_setup_codes" ADD CONSTRAINT "password_setup_codes_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_setup_codes_one_live_per_user" ON "password_setup_codes" USING btree ("user_id") WHERE "password_setup_codes"."used_at" is null;