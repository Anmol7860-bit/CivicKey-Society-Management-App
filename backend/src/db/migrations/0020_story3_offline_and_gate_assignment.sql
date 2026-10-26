CREATE TYPE "public"."visit_source" AS ENUM('ONLINE', 'MANUAL_OFFLINE');--> statement-breakpoint
ALTER TYPE "public"."client_event_result" ADD VALUE 'FAILED_RETRY' BEFORE 'REJECTED';--> statement-breakpoint
CREATE TABLE "guard_gate_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guard_user_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"end_at" timestamp with time zone,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guard_gate_assignments_guard_gate_start_unique" UNIQUE("guard_user_id","gate_id","start_at"),
	CONSTRAINT "guard_gate_assignments_end_after_start" CHECK ("guard_gate_assignments"."end_at" is null or "guard_gate_assignments"."end_at" > "guard_gate_assignments"."start_at")
);
--> statement-breakpoint
CREATE TABLE "guard_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"society_id" uuid NOT NULL,
	"employee_code" varchar(60) NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guard_profiles_society_id_employee_code_unique" UNIQUE("society_id","employee_code")
);
--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "code" varchar(40);--> statement-breakpoint
-- Existing gates get a code from their name, de-duplicated within the society, then the column is required
UPDATE "gates" g SET "code" = left(upper(regexp_replace(g."name", '[^a-zA-Z0-9]', '', 'g')), 36) || CASE WHEN d.n > 1 THEN '-' || d.n::text ELSE '' END
  FROM (SELECT id, row_number() OVER (PARTITION BY society_id, left(upper(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g')), 36) ORDER BY created_at, id) AS n FROM "gates") d
  WHERE d.id = g.id;--> statement-breakpoint
UPDATE "gates" SET "code" = 'GATE-' || left(id::text, 8) WHERE "code" IS NULL OR "code" = '';--> statement-breakpoint
ALTER TABLE "gates" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_client_events" ADD COLUMN "device_id" varchar(120) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_client_events" ADD COLUMN "result_payload" jsonb;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "source" "visit_source" DEFAULT 'ONLINE' NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "review_reason" varchar(120);--> statement-breakpoint
ALTER TABLE "guard_gate_assignments" ADD CONSTRAINT "guard_gate_assignments_guard_user_id_users_id_fk" FOREIGN KEY ("guard_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_gate_assignments" ADD CONSTRAINT "guard_gate_assignments_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_gate_assignments" ADD CONSTRAINT "guard_gate_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_profiles" ADD CONSTRAINT "guard_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_profiles" ADD CONSTRAINT "guard_profiles_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guard_gate_assignments_active_idx" ON "guard_gate_assignments" USING btree ("guard_user_id","gate_id","start_at","end_at");--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_society_id_code_unique" UNIQUE("society_id","code");