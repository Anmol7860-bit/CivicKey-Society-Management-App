CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_id_society_id_unique" UNIQUE("id","society_id"),
	CONSTRAINT "blocks_name_trimmed" CHECK ("blocks"."name" = btrim("blocks"."name") and "blocks"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE "floors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"label" varchar(40) NOT NULL,
	"display_order" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floors_id_block_id_unique" UNIQUE("id","block_id"),
	CONSTRAINT "floors_label_normalized" CHECK ("floors"."label" = btrim("floors"."label") and "floors"."label" <> '' and "floors"."label" !~ '[[:space:]]{2}')
);
--> statement-breakpoint
ALTER TABLE "flats" DROP CONSTRAINT "flats_society_block_number_unique";--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "block_id" uuid;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "floor_id" uuid;--> statement-breakpoint

-- Existing flats: one block per distinct block name, and an "Unassigned" floor in each block for
-- the Admin to move them from, since the old rows have no floor
INSERT INTO "blocks" ("society_id", "name")
SELECT DISTINCT ON ("society_id", lower(btrim("block"))) "society_id", btrim("block") FROM "flats";--> statement-breakpoint
INSERT INTO "floors" ("block_id", "label") SELECT "id", 'Unassigned' FROM "blocks";--> statement-breakpoint
UPDATE "flats" f SET "block_id" = b."id", "number" = btrim(f."number")
FROM "blocks" b WHERE b."society_id" = f."society_id" AND lower(b."name") = lower(btrim(f."block"));--> statement-breakpoint
UPDATE "flats" f SET "floor_id" = fl."id" FROM "floors" fl WHERE fl."block_id" = f."block_id";--> statement-breakpoint
ALTER TABLE "flats" ALTER COLUMN "block_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "flats" ALTER COLUMN "floor_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "flats" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "address" varchar(500);--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_society_id_name_unique" ON "blocks" USING btree ("society_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "floors_block_id_label_unique" ON "floors" USING btree ("block_id",lower("label"));--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_block_id_society_id_blocks_fk" FOREIGN KEY ("block_id","society_id") REFERENCES "public"."blocks"("id","society_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_floor_id_block_id_floors_fk" FOREIGN KEY ("floor_id","block_id") REFERENCES "public"."floors"("id","block_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flats_floor_id_idx" ON "flats" USING btree ("floor_id");--> statement-breakpoint
ALTER TABLE "flats" DROP COLUMN "block";--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_block_id_number_unique" UNIQUE("block_id","number");--> statement-breakpoint
ALTER TABLE "flats" ADD CONSTRAINT "flats_number_trimmed" CHECK ("flats"."number" = btrim("flats"."number") and "flats"."number" <> '');