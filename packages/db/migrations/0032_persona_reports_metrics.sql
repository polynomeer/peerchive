-- S-07(ADR 0036): 새 열(reports·moderation_actions의 persona_id·profile_post_id·social_link_id)은 외래 키가 없습니다 — 탈퇴 정리가 페르소나·글·링크를
-- 지워도 신고·조치 기록은 남아야 하기 때문입니다. social DB 역할 권한(peerchive_apply_social_grants)은 social_links·profile_posts에 테이블 단위
-- SELECT라 새 열(social_links.hidden_at)도 그대로 읽히고, 새 표(persona_owner_lookups)는 운영 기록이라 역할에 주지 않습니다. 그래서 함수를 다시
-- 정의하지 않습니다.
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'persona_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'identity_link_toggled';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'visibility_changed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'project_listed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'follow_requested';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'follow_approved';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'follower_removed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'block_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'mute_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'feed_item_opened';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'social_link_verified';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_persona';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_profile_post';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_social_link';--> statement-breakpoint
ALTER TYPE "public"."report_reason" ADD VALUE 'impersonation';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'persona';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'profile_post';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'social_link';--> statement-breakpoint
CREATE TABLE "persona_owner_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_owner_lookups_reason_check" CHECK (char_length("persona_owner_lookups"."reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "profile_post_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "social_link_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "profile_post_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "social_link_id" uuid;--> statement-breakpoint
ALTER TABLE "social_links" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persona_owner_lookups" ADD CONSTRAINT "persona_owner_lookups_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_owner_lookups" ADD CONSTRAINT "persona_owner_lookups_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_owner_lookups" ADD CONSTRAINT "persona_owner_lookups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_owner_lookups_report_idx" ON "persona_owner_lookups" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "persona_owner_lookups_created_idx" ON "persona_owner_lookups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_persona_idx" ON "moderation_actions" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_profile_post_idx" ON "moderation_actions" USING btree ("profile_post_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_social_link_idx" ON "moderation_actions" USING btree ("social_link_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_persona_check" CHECK ("moderation_actions"."kind"::text <> 'hide_persona' or "moderation_actions"."persona_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_profile_post_check" CHECK ("moderation_actions"."kind"::text <> 'hide_profile_post' or "moderation_actions"."profile_post_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_social_link_check" CHECK ("moderation_actions"."kind"::text <> 'hide_social_link' or "moderation_actions"."social_link_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_impersonation_check" CHECK ("reports"."reason"::text <> 'impersonation' or "reports"."target_type"::text in ('persona', 'profile'));--> statement-breakpoint
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
        or ("reports"."target_type"::text = 'social_link' and "reports"."social_link_id" is not null));