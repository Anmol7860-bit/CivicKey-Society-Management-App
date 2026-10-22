CREATE TYPE "public"."access_request_kind" AS ENUM('HOUSEHOLD_MEMBER', 'DAILY_HELP');--> statement-breakpoint
CREATE TYPE "public"."access_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('CAR', 'BIKE', 'SCOOTER', 'BICYCLE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."visit_purpose" AS ENUM('GUEST', 'DELIVERY', 'CAB', 'SERVICE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('WAITING', 'APPROVED', 'LEAVE_AT_GATE', 'DENIED', 'INSIDE', 'LEFT');--> statement-breakpoint
CREATE TYPE "public"."visitor_pass_status" AS ENUM('ACTIVE', 'USED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."visitor_pass_type" AS ENUM('ONE_ENTRY', 'MULTI_ENTRY');--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"kind" "access_request_kind" NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(15) NOT NULL,
	"relationship" varchar(60),
	"access_level" "flat_access",
	"timings" varchar(40),
	"requested_by" uuid NOT NULL,
	"status" "access_request_status" DEFAULT 'PENDING' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_requests_phone_digits" CHECK ("access_requests"."phone" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "access_requests_name_trimmed" CHECK ("access_requests"."name" = btrim("access_requests"."name") and "access_requests"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE "flat_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"number" varchar(16) NOT NULL,
	"vehicle_type" "vehicle_type" DEFAULT 'CAR' NOT NULL,
	"make_colour" varchar(60),
	"added_by" uuid,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flat_vehicles_number_trimmed" CHECK ("flat_vehicles"."number" = btrim("flat_vehicles"."number") and "flat_vehicles"."number" <> '')
);
--> statement-breakpoint
CREATE TABLE "staff_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"gate_id" uuid,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_by" uuid,
	"exited_at" timestamp with time zone,
	"exit_by" uuid,
	CONSTRAINT "staff_attendance_exit_after_entry" CHECK ("staff_attendance"."exited_at" is null or "staff_attendance"."exited_at" >= "staff_attendance"."entered_at")
);
--> statement-breakpoint
CREATE TABLE "staff_leave" (
	"staff_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"marked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_leave_staff_id_on_date_pk" PRIMARY KEY("staff_id","on_date")
);
--> statement-breakpoint
CREATE TABLE "visitor_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"visitor_name" varchar(120) NOT NULL,
	"visitor_phone" varchar(15) NOT NULL,
	"purpose" "visit_purpose" DEFAULT 'GUEST' NOT NULL,
	"people" integer DEFAULT 1 NOT NULL,
	"valid_on" date NOT NULL,
	"valid_from" time NOT NULL,
	"valid_until" time NOT NULL,
	"vehicle_number" varchar(16),
	"pass_type" "visitor_pass_type" DEFAULT 'ONE_ENTRY' NOT NULL,
	"note" varchar(200),
	"entry_code" varchar(6) NOT NULL,
	"status" "visitor_pass_status" DEFAULT 'ACTIVE' NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_passes_society_id_entry_code_unique" UNIQUE("society_id","entry_code"),
	CONSTRAINT "visitor_passes_entry_code_digits" CHECK ("visitor_passes"."entry_code" ~ '^[0-9]{6}$'),
	CONSTRAINT "visitor_passes_phone_digits" CHECK ("visitor_passes"."visitor_phone" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "visitor_passes_people_range" CHECK ("visitor_passes"."people" between 1 and 50),
	CONSTRAINT "visitor_passes_window" CHECK ("visitor_passes"."valid_until" > "visitor_passes"."valid_from"),
	CONSTRAINT "visitor_passes_name_trimmed" CHECK ("visitor_passes"."visitor_name" = btrim("visitor_passes"."visitor_name") and "visitor_passes"."visitor_name" <> '')
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"gate_id" uuid,
	"flat_id" uuid NOT NULL,
	"pass_id" uuid,
	"visitor_name" varchar(120) NOT NULL,
	"visitor_phone" varchar(15) NOT NULL,
	"purpose" "visit_purpose" NOT NULL,
	"company" varchar(120),
	"people" integer DEFAULT 1 NOT NULL,
	"vehicle_number" varchar(16),
	"note" varchar(200),
	"photo_reference" varchar(200),
	"status" "visit_status" DEFAULT 'WAITING' NOT NULL,
	"registered_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(200),
	"entered_at" timestamp with time zone,
	"entry_by" uuid,
	"exited_at" timestamp with time zone,
	"exit_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visits_phone_digits" CHECK ("visits"."visitor_phone" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "visits_people_range" CHECK ("visits"."people" between 1 and 50),
	CONSTRAINT "visits_decision_recorded" CHECK (("visits"."decided_at" is null) or ("visits"."status" <> 'WAITING')),
	CONSTRAINT "visits_exit_after_entry" CHECK ("visits"."exited_at" is null or ("visits"."entered_at" is not null and "visits"."exited_at" >= "visits"."entered_at"))
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_vehicles" ADD CONSTRAINT "flat_vehicles_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_vehicles" ADD CONSTRAINT "flat_vehicles_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_vehicles" ADD CONSTRAINT "flat_vehicles_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_entry_by_users_id_fk" FOREIGN KEY ("entry_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_exit_by_users_id_fk" FOREIGN KEY ("exit_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_leave" ADD CONSTRAINT "staff_leave_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_leave" ADD CONSTRAINT "staff_leave_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_pass_id_visitor_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."visitor_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_entry_by_users_id_fk" FOREIGN KEY ("entry_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_exit_by_users_id_fk" FOREIGN KEY ("exit_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_requests_society_id_status_idx" ON "access_requests" USING btree ("society_id","status");--> statement-breakpoint
CREATE INDEX "access_requests_flat_id_idx" ON "access_requests" USING btree ("flat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flat_vehicles_society_id_number_unique" ON "flat_vehicles" USING btree ("society_id",upper("number"));--> statement-breakpoint
CREATE INDEX "flat_vehicles_flat_id_idx" ON "flat_vehicles" USING btree ("flat_id");--> statement-breakpoint
CREATE INDEX "staff_attendance_staff_id_entered_at_idx" ON "staff_attendance" USING btree ("staff_id","entered_at");--> statement-breakpoint
CREATE INDEX "visitor_passes_flat_id_valid_on_idx" ON "visitor_passes" USING btree ("flat_id","valid_on");--> statement-breakpoint
CREATE INDEX "visits_society_id_status_idx" ON "visits" USING btree ("society_id","status");--> statement-breakpoint
CREATE INDEX "visits_flat_id_created_at_idx" ON "visits" USING btree ("flat_id","created_at");