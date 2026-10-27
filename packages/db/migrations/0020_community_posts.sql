CREATE TYPE "public"."community_item_status" AS ENUM('published', 'deleted_by_author', 'hidden', 'auto_hidden');--> statement-breakpoint
CREATE TYPE "public"."community_reaction_kind" AS ENUM('empathy');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'post_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'comment_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'reaction_added';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'post_commented';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_post';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_comment';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'community_post';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'community_comment';--> statement-breakpoint
CREATE TABLE "community_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"author_id" uuid NOT NULL,
	"name_mode" "community_name_mode" NOT NULL,
	"body" text NOT NULL,
	"status" "community_item_status" DEFAULT 'published' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_comments_content_check" CHECK (("community_comments"."status" = 'deleted_by_author' and "community_comments"."body" = '' and "community_comments"."deleted_at" is not null)
        or ("community_comments"."status" <> 'deleted_by_author' and char_length("community_comments"."body") between 1 and 3000 and "community_comments"."deleted_at" is null)),
	CONSTRAINT "community_comments_version_check" CHECK ("community_comments"."version" >= 1),
	CONSTRAINT "community_comments_parent_self_check" CHECK ("community_comments"."parent_comment_id" is null or "community_comments"."parent_comment_id" <> "community_comments"."id")
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"name_mode" "community_name_mode" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "community_item_status" DEFAULT 'published' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_posts_content_check" CHECK (("community_posts"."status" = 'deleted_by_author' and "community_posts"."title" = '' and "community_posts"."body" = '' and "community_posts"."deleted_at" is not null)
        or ("community_posts"."status" <> 'deleted_by_author' and char_length("community_posts"."title") between 1 and 120 and char_length("community_posts"."body") between 1 and 10000 and "community_posts"."deleted_at" is null)),
	CONSTRAINT "community_posts_version_check" CHECK ("community_posts"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "community_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" "community_reaction_kind" DEFAULT 'empathy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_reactions_target_check" CHECK (("community_reactions"."post_id" is null) <> ("community_reactions"."comment_id" is null))
);
--> statement-breakpoint
CREATE TABLE "thread_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"alias_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_aliases_alias_no_check" CHECK ("thread_aliases"."alias_no" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "community_notices" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_post_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "community_post_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "community_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_parent_comment_id_community_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_aliases" ADD CONSTRAINT "thread_aliases_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_aliases" ADD CONSTRAINT "thread_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_comments_post_created_idx" ON "community_comments" USING btree ("post_id","created_at","id");--> statement-breakpoint
CREATE INDEX "community_comments_author_idx" ON "community_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "community_comments_parent_idx" ON "community_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "community_posts_board_created_idx" ON "community_posts" USING btree ("board_id","created_at","id");--> statement-breakpoint
CREATE INDEX "community_posts_author_idx" ON "community_posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "community_posts_space_idx" ON "community_posts" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_reactions_post_user_key" ON "community_reactions" USING btree ("post_id","user_id","kind") WHERE "community_reactions"."post_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "community_reactions_comment_user_key" ON "community_reactions" USING btree ("comment_id","user_id","kind") WHERE "community_reactions"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX "community_reactions_user_idx" ON "community_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_aliases_post_user_key" ON "thread_aliases" USING btree ("post_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_aliases_post_alias_key" ON "thread_aliases" USING btree ("post_id","alias_no");--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_post_id_community_posts_id_fk" FOREIGN KEY ("community_post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_comment_id_community_comments_id_fk" FOREIGN KEY ("community_comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_post_id_community_posts_id_fk" FOREIGN KEY ("community_post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_comment_id_community_comments_id_fk" FOREIGN KEY ("community_comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_notices_post_unread_key" ON "community_notices" USING btree ("post_id","user_id") WHERE "community_notices"."post_id" is not null and "community_notices"."read_at" is null;--> statement-breakpoint
CREATE INDEX "moderation_actions_community_post_idx" ON "moderation_actions" USING btree ("community_post_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_community_comment_idx" ON "moderation_actions" USING btree ("community_comment_id");--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_target_check" CHECK (("community_notices"."post_id" is null) or ("community_notices"."name_mode_change_id" is null));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_post_check" CHECK ("moderation_actions"."kind"::text <> 'hide_post' or "moderation_actions"."community_post_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_comment_check" CHECK ("moderation_actions"."kind"::text <> 'hide_comment' or "moderation_actions"."community_comment_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null)
        or ("reports"."target_type"::text = 'community_space' and "reports"."community_space_id" is not null)
        or ("reports"."target_type"::text = 'community_post' and "reports"."community_post_id" is not null)
        or ("reports"."target_type"::text = 'community_comment' and "reports"."community_comment_id" is not null));--> statement-breakpoint
-- C-04(ADR 0020·0022): 작성 시점 고정 열을 바꾸는 UPDATE를 DB가 거부합니다(drizzle 스키마가 표현하지 못해 손으로 둔 SQL, 스냅샷과 무관).
-- 글: name_mode·author_id·space_id·board_id / 댓글: name_mode·author_id·post_id·parent_comment_id / 스레드 익명 번호: 모든 UPDATE.
CREATE FUNCTION "public"."community_frozen_columns_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'thread_aliases' THEN
    RAISE EXCEPTION 'thread_aliases rows are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.name_mode IS DISTINCT FROM OLD.name_mode OR NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION '%.name_mode/author_id are frozen at write time', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'community_posts' THEN
    IF NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.board_id IS DISTINCT FROM OLD.board_id THEN
      RAISE EXCEPTION 'community_posts.space_id/board_id are frozen' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'community_comments' THEN
    IF NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id THEN
      RAISE EXCEPTION 'community_comments.post_id/parent_comment_id are frozen' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "community_posts_frozen_columns" BEFORE UPDATE ON "community_posts" FOR EACH ROW EXECUTE FUNCTION "public"."community_frozen_columns_guard"();--> statement-breakpoint
CREATE TRIGGER "community_comments_frozen_columns" BEFORE UPDATE ON "community_comments" FOR EACH ROW EXECUTE FUNCTION "public"."community_frozen_columns_guard"();--> statement-breakpoint
CREATE TRIGGER "thread_aliases_immutable" BEFORE UPDATE ON "thread_aliases" FOR EACH ROW EXECUTE FUNCTION "public"."community_frozen_columns_guard"();
