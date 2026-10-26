-- A tenancy's end date is now set when the tenant moves out, not demanded when they move in.
-- A tenancy whose end is already known is still a tenancy that is running now, and the gate has
-- to be able to tell "ends later" from "has ended".
ALTER TABLE "flat_residents" DROP CONSTRAINT IF EXISTS "flat_residents_tenant_end_date";
