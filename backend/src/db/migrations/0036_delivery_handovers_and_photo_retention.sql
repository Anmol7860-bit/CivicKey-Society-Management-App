ALTER TYPE "public"."notification_event" ADD VALUE 'DELIVERY_AT_GATE' BEFORE 'STAFF_ENTERED';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'DELIVERY_COLLECTED' BEFORE 'STAFF_ENTERED';--> statement-breakpoint
CREATE TABLE "delivery_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"society_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"gate_id" uuid,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_code" varchar(6) NOT NULL,
	"note" varchar(200),
	"collected_at" timestamp with time zone,
	"collected_by" uuid,
	"collected_by_name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_collection_recorded" CHECK (("delivery_handovers"."collected_at" is null) = ("delivery_handovers"."collected_by" is null))
);
--> statement-breakpoint
ALTER TABLE "society_settings" ADD COLUMN "photo_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_handovers" ADD CONSTRAINT "delivery_handovers_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_handovers_visit_id_unique" ON "delivery_handovers" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "delivery_handovers_flat_id_idx" ON "delivery_handovers" USING btree ("flat_id","collected_at");