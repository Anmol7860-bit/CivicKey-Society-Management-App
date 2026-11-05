CREATE TYPE "public"."group_member_role" AS ENUM('LEADER', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."group_scope" AS ENUM('SOCIETY', 'BLOCK', 'CUSTOM');--> statement-breakpoint
CREATE TABLE "community_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "group_member_role" DEFAULT 'MEMBER' NOT NULL,
	"added_by" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"purpose" varchar(300),
	"scope" "group_scope" DEFAULT 'CUSTOM' NOT NULL,
	"block_id" uuid,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_groups_name_trimmed" CHECK ("community_groups"."name" = btrim("community_groups"."name") and "community_groups"."name" <> ''),
	CONSTRAINT "community_groups_block_matches_scope" CHECK (("community_groups"."scope" = 'BLOCK') = ("community_groups"."block_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "community_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" varchar(2000) NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_messages_body_present" CHECK (btrim("community_messages"."body") <> ''),
	CONSTRAINT "community_messages_deletion_recorded" CHECK (("community_messages"."deleted_at" is null) = ("community_messages"."deleted_by" is null))
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" varchar(2000) NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_body_present" CHECK (btrim("task_comments"."body") <> ''),
	CONSTRAINT "task_comments_deletion_recorded" CHECK (("task_comments"."deleted_at" is null) = ("task_comments"."deleted_by" is null))
);
--> statement-breakpoint
CREATE TABLE "task_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "community_group_members" ADD CONSTRAINT "community_group_members_group_id_community_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."community_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_group_members" ADD CONSTRAINT "community_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_group_members" ADD CONSTRAINT "community_group_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_groups" ADD CONSTRAINT "community_groups_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_groups" ADD CONSTRAINT "community_groups_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_groups" ADD CONSTRAINT "community_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_group_id_community_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."community_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_community_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."community_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_task_id_community_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."community_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_group_members_one_live_per_user" ON "community_group_members" USING btree ("group_id","user_id") WHERE "community_group_members"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "community_group_members_user_id_idx" ON "community_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_groups_society_id_name_unique" ON "community_groups" USING btree ("society_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "community_groups_one_society_channel" ON "community_groups" USING btree ("society_id") WHERE "community_groups"."scope" = 'SOCIETY' and "community_groups"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "community_groups_one_block_channel" ON "community_groups" USING btree ("block_id") WHERE "community_groups"."scope" = 'BLOCK' and "community_groups"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "community_messages_group_id_created_at_idx" ON "community_messages" USING btree ("group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_comments_task_id_created_at_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_participants_one_live_per_user" ON "task_participants" USING btree ("task_id","user_id") WHERE "task_participants"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "task_participants_user_id_idx" ON "task_participants" USING btree ("user_id");
-- Master data: the two permissions the community space needs.
-- Codes must match modules/access/permissions.ts
INSERT INTO "permissions" ("code", "description") VALUES
	('GROUP_MANAGE', 'Create and archive community groups, appoint leaders and moderate messages'),
	('COMMUNITY_POST', 'Post in the society and group chats and comment on an assigned task')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- Every Resident may post; GROUP_MANAGE is granted per Admin in user_permissions, as all Admin
-- permissions are, so it gets no role_permissions row.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON
	r."name" = 'RESIDENT' AND p."code" = 'COMMUNITY_POST'
ON CONFLICT DO NOTHING;
