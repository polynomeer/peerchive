-- A-07 운영·계측(ADR 0045).
-- 1) 신고 대상 room_item(동문회·OB 방의 명부 항목·일정·투표·앨범 사진·방별 프로필) + 조치 hide_room_item + 각 표의 hidden_at, 명부 항목 id.
-- 2) 신고 사유 affiliation_impersonation(소속·기수 사칭): 커뮤니티 글·댓글·수료 회고·방 항목(명부·방별 프로필)에만.
-- 3) §6.2 P2 분석 이벤트 6개.
-- drizzle migrate는 처음부터 돌릴 때 모든 migration을 한 트랜잭션에서 실행하고, PostgreSQL은 ADD VALUE한 enum 값을 같은 트랜잭션에서 쓸 수 없습니다.
-- 그래서 ADD VALUE한 값(room_item·hide_room_item·affiliation_impersonation)을 쓰는 check는 모두 `::text`로 비교합니다. 새로 만든 enum(room_item_kind)은
-- 같은 트랜잭션에서 써도 되지만 같은 방식으로 맞췄습니다.
CREATE TYPE "public"."room_item_kind" AS ENUM('directory_entry', 'event', 'poll', 'album_photo', 'room_profile');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'alumni_room_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'event_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'rsvp_submitted';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'directory_consent_changed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'topic_post_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'completion_retro_published';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_room_item';--> statement-breakpoint
ALTER TYPE "public"."report_reason" ADD VALUE 'affiliation_impersonation';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'room_item';--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "directory_entries" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_entries" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "room_item_kind" "room_item_kind";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "room_item_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "room_item_kind" "room_item_kind";--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "room_item_id" uuid;--> statement-breakpoint
ALTER TABLE "room_album_photos" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_events" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_polls" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_profiles" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_entries_id_key" ON "directory_entries" USING btree ("id");--> statement-breakpoint
CREATE INDEX "moderation_actions_room_item_idx" ON "moderation_actions" USING btree ("room_item_id");--> statement-breakpoint
CREATE INDEX "reports_room_item_idx" ON "reports" USING btree ("room_item_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_room_item_check" CHECK ("moderation_actions"."kind"::text <> 'hide_room_item' or ("moderation_actions"."room_item_kind" is not null and "moderation_actions"."room_item_id" is not null));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_affiliation_impersonation_check" CHECK ("reports"."reason"::text <> 'affiliation_impersonation' or "reports"."target_type"::text in ('community_post', 'community_comment', 'completion_retro')
        or ("reports"."target_type"::text = 'room_item' and "reports"."room_item_kind"::text in ('directory_entry', 'room_profile')));--> statement-breakpoint
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
        or ("reports"."target_type"::text = 'room_item' and "reports"."room_item_kind" is not null and "reports"."room_item_id" is not null));