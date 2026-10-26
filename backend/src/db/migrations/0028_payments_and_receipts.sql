CREATE TYPE "public"."payment_attempt_status" AS ENUM('INITIATING', 'CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'REVIEW_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('PENDING_PDF', 'READY', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'OVERDUE' BEFORE 'PARTIALLY_PAID';--> statement-breakpoint
CREATE TABLE "gateway_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) DEFAULT 'razorpay' NOT NULL,
	"provider_event_id" varchar(100) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"payload" jsonb NOT NULL,
	"handled_at" timestamp with time zone,
	"result" varchar(60),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_events_provider_event_unique" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"society_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'INITIATING' NOT NULL,
	"provider_order_id" varchar(64),
	"provider_payment_id" varchar(64),
	"failure_reason" varchar(300),
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_provider_order_id_unique" UNIQUE("provider_order_id"),
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"society_id" uuid NOT NULL,
	"number" varchar(24) NOT NULL,
	"status" "receipt_status" DEFAULT 'PENDING_PDF' NOT NULL,
	"file_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_image_type";--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempts_invoice_id_idx" ON "payment_attempts" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_success_per_invoice" ON "payment_attempts" USING btree ("invoice_id") WHERE status = 'SUCCESS';--> statement-breakpoint
CREATE INDEX "receipts_status_idx" ON "receipts" USING btree ("status");--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_image_type" CHECK ("stored_files"."content_type" in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));