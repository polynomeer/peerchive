CREATE TYPE "public"."stuck_qa_post_kind" AS ENUM('question', 'answer');--> statement-breakpoint
CREATE TYPE "public"."stuck_qa_post_status" AS ENUM('published', 'withdrawn', 'hidden');--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_stuck_qa_post';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'stuck_qa_post';--> statement-breakpoint
CREATE TABLE "stuck_qa_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"alias_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stuck_qa_aliases_alias_no_check" CHECK ("stuck_qa_aliases"."alias_no" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stuck_qa_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"author_id" uuid,
	"questions_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stuck_qa_cards_publication_item_key" UNIQUE("publication_id","item_key"),
	CONSTRAINT "stuck_qa_cards_item_key_check" CHECK (char_length("stuck_qa_cards"."item_key") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "stuck_qa_helpful" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stuck_qa_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" "stuck_qa_post_kind" NOT NULL,
	"by_log_author" boolean DEFAULT false NOT NULL,
	"alias_no" integer,
	"body" text NOT NULL,
	"count_as_contribution" boolean DEFAULT false NOT NULL,
	"status" "stuck_qa_post_status" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "stuck_qa_posts_alias_check" CHECK (("stuck_qa_posts"."by_log_author" and "stuck_qa_posts"."alias_no" is null) or (not "stuck_qa_posts"."by_log_author" and "stuck_qa_posts"."alias_no" is not null and "stuck_qa_posts"."alias_no" >= 0)),
	CONSTRAINT "stuck_qa_posts_body_check" CHECK (("stuck_qa_posts"."status"::text = 'withdrawn' and "stuck_qa_posts"."body" = '') or ("stuck_qa_posts"."status"::text <> 'withdrawn' and char_length("stuck_qa_posts"."body") between 1 and 2000)),
	CONSTRAINT "stuck_qa_posts_withdrawn_check" CHECK (("stuck_qa_posts"."status"::text = 'withdrawn') = ("stuck_qa_posts"."withdrawn_at" is not null)),
	CONSTRAINT "stuck_qa_posts_contribution_check" CHECK ("stuck_qa_posts"."kind"::text = 'answer' or not "stuck_qa_posts"."count_as_contribution")
);
--> statement-breakpoint
CREATE TABLE "stuck_qa_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"asker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_post_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "stuck_qa_post_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "stuck_qa_post_id" uuid;--> statement-breakpoint
ALTER TABLE "stuck_qa_aliases" ADD CONSTRAINT "stuck_qa_aliases_thread_id_stuck_qa_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."stuck_qa_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_aliases" ADD CONSTRAINT "stuck_qa_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_cards" ADD CONSTRAINT "stuck_qa_cards_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_cards" ADD CONSTRAINT "stuck_qa_cards_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_helpful" ADD CONSTRAINT "stuck_qa_helpful_post_id_stuck_qa_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."stuck_qa_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_helpful" ADD CONSTRAINT "stuck_qa_helpful_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_posts" ADD CONSTRAINT "stuck_qa_posts_thread_id_stuck_qa_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."stuck_qa_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_posts" ADD CONSTRAINT "stuck_qa_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_threads" ADD CONSTRAINT "stuck_qa_threads_card_id_stuck_qa_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."stuck_qa_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_qa_threads" ADD CONSTRAINT "stuck_qa_threads_asker_id_users_id_fk" FOREIGN KEY ("asker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stuck_qa_aliases_thread_user_key" ON "stuck_qa_aliases" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stuck_qa_aliases_thread_alias_key" ON "stuck_qa_aliases" USING btree ("thread_id","alias_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stuck_qa_helpful_post_user_key" ON "stuck_qa_helpful" USING btree ("post_id","user_id");--> statement-breakpoint
CREATE INDEX "stuck_qa_helpful_user_idx" ON "stuck_qa_helpful" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stuck_qa_posts_thread_idx" ON "stuck_qa_posts" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "stuck_qa_posts_author_idx" ON "stuck_qa_posts" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stuck_qa_posts_question_key" ON "stuck_qa_posts" USING btree ("thread_id") WHERE "stuck_qa_posts"."kind" = 'question';--> statement-breakpoint
CREATE INDEX "stuck_qa_threads_card_idx" ON "stuck_qa_threads" USING btree ("card_id","last_post_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_stuck_qa_post_id_stuck_qa_posts_id_fk" FOREIGN KEY ("stuck_qa_post_id") REFERENCES "public"."stuck_qa_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_stuck_qa_post_id_stuck_qa_posts_id_fk" FOREIGN KEY ("stuck_qa_post_id") REFERENCES "public"."stuck_qa_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_stuck_qa_post_idx" ON "moderation_actions" USING btree ("stuck_qa_post_id");--> statement-breakpoint
CREATE INDEX "reports_stuck_qa_post_idx" ON "reports" USING btree ("stuck_qa_post_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_stuck_qa_post_check" CHECK ("moderation_actions"."kind"::text <> 'hide_stuck_qa_post' or "moderation_actions"."stuck_qa_post_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null)
        or ("reports"."target_type"::text = 'community_space' and "reports"."community_space_id" is not null)
        or ("reports"."target_type"::text = 'community_post' and "reports"."community_post_id" is not null)
        or ("reports"."target_type"::text = 'community_comment' and "reports"."community_comment_id" is not null)
        or ("reports"."target_type"::text = 'community_recruitment' and "reports"."community_recruitment_id" is not null)
        or ("reports"."target_type"::text = 'community_application' and "reports"."community_application_id" is not null)
        or ("reports"."target_type"::text = 'course_qa' and "reports"."course_qa_item_id" is not null)
        or ("reports"."target_type"::text = 'persona' and "reports"."persona_id" is not null)
        or ("reports"."target_type"::text = 'profile_post' and "reports"."profile_post_id" is not null)
        or ("reports"."target_type"::text = 'social_link' and "reports"."social_link_id" is not null)
        or ("reports"."target_type"::text = 'completion_retro' and "reports"."completion_retro_id" is not null)
        or ("reports"."target_type"::text = 'room_item' and "reports"."room_item_kind" is not null and "reports"."room_item_id" is not null)
        or ("reports"."target_type"::text = 'stuck_qa_post' and "reports"."stuck_qa_post_id" is not null));