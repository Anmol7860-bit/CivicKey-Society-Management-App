CREATE TYPE "public"."task_category" AS ENUM('PLUMBING', 'ELECTRICAL', 'HOUSEKEEPING', 'SECURITY', 'LIFT', 'PARKING', 'GARDEN', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('LOW', 'NORMAL', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "community_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"details" text,
	"category" "task_category" DEFAULT 'OTHER' NOT NULL,
	"priority" "task_priority" DEFAULT 'NORMAL' NOT NULL,
	"status" "task_status" DEFAULT 'OPEN' NOT NULL,
	"location" varchar(120),
	"due_date" date,
	"assigned_staff_id" uuid,
	"raised_by" uuid,
	"closed_at" timestamp with time zone,
	"closing_note" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_tasks_title_trimmed" CHECK ("community_tasks"."title" = btrim("community_tasks"."title") and "community_tasks"."title" <> ''),
	CONSTRAINT "community_tasks_closed_recorded" CHECK (("community_tasks"."status" in ('DONE', 'CANCELLED')) = ("community_tasks"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "community_tasks" ADD CONSTRAINT "community_tasks_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_tasks" ADD CONSTRAINT "community_tasks_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_tasks" ADD CONSTRAINT "community_tasks_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_tasks_society_id_status_idx" ON "community_tasks" USING btree ("society_id","status");--> statement-breakpoint
CREATE INDEX "community_tasks_assigned_staff_id_idx" ON "community_tasks" USING btree ("assigned_staff_id");