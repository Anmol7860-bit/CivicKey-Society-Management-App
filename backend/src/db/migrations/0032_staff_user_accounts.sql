ALTER TABLE "staff" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_unique" UNIQUE("user_id");--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_only_for_guards" CHECK ("staff"."user_id" is null or "staff"."kind" = 'GUARD');