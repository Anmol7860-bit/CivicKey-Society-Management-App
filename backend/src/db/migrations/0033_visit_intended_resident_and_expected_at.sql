ALTER TABLE "visits" ADD COLUMN "intended_resident_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "expected_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_intended_resident_id_users_id_fk" FOREIGN KEY ("intended_resident_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;