ALTER TABLE "invoices" DROP CONSTRAINT "invoices_period_is_month_start";--> statement-breakpoint
ALTER TABLE "billing_rates" ALTER COLUMN "due_day" SET DEFAULT 16;--> statement-breakpoint
-- NOT VALID on purpose: maintenance is billed by the quarter from now on, and the monthly
-- invoices issued before this change keep the periods they were issued under. An issued
-- invoice is immutable, so moving them would rewrite the society's own records.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period_is_quarter_start" CHECK (date_trunc('quarter', "invoices"."period") = "invoices"."period") NOT VALID;