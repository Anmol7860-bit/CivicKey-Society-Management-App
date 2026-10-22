-- Receipt numbers are issued by the database, so two admins recording a payment at the same
-- moment can never be given the same number.
CREATE SEQUENCE "receipt_number_seq";--> statement-breakpoint
CREATE TYPE "public"."charge_basis" AS ENUM('PER_SQFT', 'PER_FLAT');--> statement-breakpoint
CREATE TYPE "public"."flat_type" AS ENUM('STUDIO', 'ONE_BHK', 'TWO_BHK', 'THREE_BHK', 'FOUR_BHK', 'PENTHOUSE', 'SHOP');--> statement-breakpoint
CREATE TYPE "public"."gate_use" AS ENUM('VISITORS_AND_RESIDENTS', 'VISITORS_ONLY', 'RESIDENTS_ONLY', 'SERVICE_AND_DELIVERY');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."police_verification" AS ENUM('NOT_STARTED', 'SUBMITTED', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."staff_kind" AS ENUM('GUARD', 'DAILY_HELP', 'VENDOR');--> statement-breakpoint
CREATE TYPE "public"."staff_shift" AS ENUM('MORNING', 'EVENING', 'NIGHT', 'FULL_DAY');--> statement-breakpoint
CREATE TABLE "billing_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"charge_basis" charge_basis NOT NULL,
	"rate" numeric(10, 2) NOT NULL,
	"sinking_fund" numeric(10, 2) DEFAULT '0' NOT NULL,
	"parking_charge" numeric(10, 2) DEFAULT '0' NOT NULL,
	"due_day" integer NOT NULL,
	"late_fee_per_day" numeric(10, 2),
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_rates_society_id_effective_from_unique" UNIQUE("society_id","effective_from"),
	CONSTRAINT "billing_rates_due_day" CHECK ("billing_rates"."due_day" between 1 and 28),
	CONSTRAINT "billing_rates_amounts_positive" CHECK ("billing_rates"."rate" > 0 and "billing_rates"."sinking_fund" >= 0 and "billing_rates"."parking_charge" >= 0),
	CONSTRAINT "billing_rates_late_fee" CHECK ("billing_rates"."late_fee_per_day" is null or "billing_rates"."late_fee_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"used_for" "gate_use" DEFAULT 'VISITORS_AND_RESIDENTS' NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gates_name_trimmed" CHECK ("gates"."name" = btrim("gates"."name") and "gates"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"period" date NOT NULL,
	"rate_id" uuid,
	"maintenance" numeric(10, 2) NOT NULL,
	"sinking_fund" numeric(10, 2) DEFAULT '0' NOT NULL,
	"parking_charge" numeric(10, 2) DEFAULT '0' NOT NULL,
	"one_time_description" varchar(120),
	"one_time_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"total" numeric(10, 2) GENERATED ALWAYS AS (maintenance + sinking_fund + parking_charge + one_time_amount) STORED,
	"due_date" date NOT NULL,
	"status" "invoice_status" DEFAULT 'UNPAID' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_flat_id_period_unique" UNIQUE("flat_id","period"),
	CONSTRAINT "invoices_period_is_month_start" CHECK (date_trunc('month', "invoices"."period") = "invoices"."period"),
	CONSTRAINT "invoices_amounts_not_negative" CHECK ("invoices"."maintenance" >= 0 and "invoices"."sinking_fund" >= 0 and "invoices"."parking_charge" >= 0 and "invoices"."one_time_amount" >= 0),
	CONSTRAINT "invoices_one_time_described" CHECK ("invoices"."one_time_amount" = 0 or "invoices"."one_time_description" is not null)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"received_on" date NOT NULL,
	"paid_by" varchar(120),
	"note" varchar(200),
	"receipt_number" varchar(24) DEFAULT 'RCT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('receipt_number_seq')::text, 6, '0') NOT NULL,
	"recorded_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_reversal_fields" CHECK (("payments"."reversed_at" is null) = ("payments"."reversed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"kind" "staff_kind" NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(15) NOT NULL,
	"work_type" varchar(60),
	"agency" varchar(120),
	"gate_id" uuid,
	"shift" "staff_shift",
	"police_verification" "police_verification" DEFAULT 'NOT_STARTED' NOT NULL,
	"gender" "gender",
	"home_address" varchar(500),
	"working_days" varchar(27),
	"id_document_type" "id_document_type",
	"id_document_hash" varchar(64),
	"id_document_last4" varchar(4),
	"photo_reference" varchar(200),
	"pass_code" varchar(16) NOT NULL,
	"pass_valid_from" date DEFAULT current_date NOT NULL,
	"pass_valid_until" date,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_pass_code_unique" UNIQUE("pass_code"),
	CONSTRAINT "staff_society_id_phone_unique" UNIQUE("society_id","phone"),
	CONSTRAINT "staff_phone_digits" CHECK ("staff"."phone" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "staff_name_trimmed" CHECK ("staff"."name" = btrim("staff"."name") and "staff"."name" <> ''),
	CONSTRAINT "staff_pass_period" CHECK ("staff"."pass_valid_until" is null or "staff"."pass_valid_until" >= "staff"."pass_valid_from"),
	CONSTRAINT "staff_id_document_hash_sha256" CHECK ("staff"."id_document_hash" is null or "staff"."id_document_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "staff_working_days" CHECK ("staff"."working_days" is null or "staff"."working_days" ~ '^(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*$')
);
--> statement-breakpoint
CREATE TABLE "staff_flats" (
	"staff_id" uuid NOT NULL,
	"flat_id" uuid NOT NULL,
	"time_window" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_flats_staff_id_flat_id_pk" PRIMARY KEY("staff_id","flat_id")
);
--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "flat_type" "flat_type";--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "carpet_area_sqft" integer;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "parking_slots" varchar(64);--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "parking_slot_count" integer GENERATED ALWAYS AS (case when btrim(coalesce(parking_slots, '')) = '' then 0 else array_length(string_to_array(parking_slots, ','), 1) end) STORED;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "intercom" varchar(20);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "registration_number" varchar(64);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "gstin" varchar(15);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "pin_code" varchar(6);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "city" varchar(80);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "state" varchar(80);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "office_phone" varchar(15);--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rate_id_billing_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."billing_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_flats" ADD CONSTRAINT "staff_flats_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_flats" ADD CONSTRAINT "staff_flats_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gates_society_id_name_unique" ON "gates" USING btree ("society_id",lower("name"));--> statement-breakpoint
CREATE INDEX "invoices_society_id_period_idx" ON "invoices" USING btree ("society_id","period");--> statement-breakpoint
CREATE INDEX "payments_invoice_id_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "staff_society_id_kind_idx" ON "staff" USING btree ("society_id","kind");--> statement-breakpoint
CREATE INDEX "staff_flats_flat_id_idx" ON "staff_flats" USING btree ("flat_id");--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_carpet_area_positive" CHECK ("flats"."carpet_area_sqft" is null or "flats"."carpet_area_sqft" > 0);--> statement-breakpoint
ALTER TABLE "societies" ADD CONSTRAINT "societies_pin_code_format" CHECK ("societies"."pin_code" is null or "societies"."pin_code" ~ '^[1-9][0-9]{5}$');--> statement-breakpoint
ALTER TABLE "societies" ADD CONSTRAINT "societies_gstin_format" CHECK ("societies"."gstin" is null or "societies"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');