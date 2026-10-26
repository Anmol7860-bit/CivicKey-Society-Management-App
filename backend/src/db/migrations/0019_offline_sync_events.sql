CREATE TYPE "public"."client_event_result" AS ENUM('IN_PROGRESS', 'APPLIED', 'DUPLICATE_IGNORED', 'REJECTED', 'NEEDS_REVIEW');--> statement-breakpoint
CREATE TABLE "processed_client_events" (
	"client_event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"operation_type" varchar(40) NOT NULL,
	"result_status" "client_event_result" DEFAULT 'IN_PROGRESS' NOT NULL,
	"entity_id" uuid,
	"result_code" varchar(60),
	"client_ts" timestamp with time zone,
	"server_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "client_event_id" uuid;--> statement-breakpoint
ALTER TABLE "processed_client_events" ADD CONSTRAINT "processed_client_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processed_client_events_user_id_server_ts_idx" ON "processed_client_events" USING btree ("user_id","server_ts");--> statement-breakpoint
CREATE INDEX "processed_client_events_result_status_idx" ON "processed_client_events" USING btree ("result_status");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_client_event_id_unique" ON "visits" USING btree ("client_event_id");