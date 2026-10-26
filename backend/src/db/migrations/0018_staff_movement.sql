CREATE TYPE "public"."staff_rejection_reason" AS ENUM('STAFF_INACTIVE', 'NOT_REGISTERED', 'WRONG_SOCIETY', 'VERIFICATION_FAILED', 'INVALID_PASS', 'ALREADY_INSIDE', 'SECURITY_CONCERN', 'OTHER');--> statement-breakpoint
CREATE TABLE "staff_entry_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"gate_id" uuid,
	"reason" "staff_rejection_reason" NOT NULL,
	"note" varchar(200),
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(150),
	CONSTRAINT "staff_entry_rejections_other_needs_note" CHECK ("staff_entry_rejections"."reason" <> 'OTHER' or ("staff_entry_rejections"."note" is not null and btrim("staff_entry_rejections"."note") <> ''))
);
--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD COLUMN "entry_key" varchar(150);--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD COLUMN "exit_key" varchar(150);--> statement-breakpoint
ALTER TABLE "staff_entry_rejections" ADD CONSTRAINT "staff_entry_rejections_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_entry_rejections" ADD CONSTRAINT "staff_entry_rejections_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_entry_rejections" ADD CONSTRAINT "staff_entry_rejections_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_entry_rejections_staff_id_rejected_at_idx" ON "staff_entry_rejections" USING btree ("staff_id","rejected_at");--> statement-breakpoint
CREATE INDEX "staff_entry_rejections_rejected_at_idx" ON "staff_entry_rejections" USING btree ("rejected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_entry_rejections_key_unique" ON "staff_entry_rejections" USING btree ("staff_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "staff_attendance_entered_at_idx" ON "staff_attendance" USING btree ("entered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_attendance_one_open_per_staff" ON "staff_attendance" USING btree ("staff_id") WHERE "staff_attendance"."exited_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_attendance_entry_key_unique" ON "staff_attendance" USING btree ("staff_id","entry_key");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_attendance_exit_key_unique" ON "staff_attendance" USING btree ("staff_id","exit_key");