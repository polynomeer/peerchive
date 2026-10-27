ALTER TYPE "public"."analytics_event_name" ADD VALUE 'community_author_lookup';--> statement-breakpoint
CREATE TABLE "ops_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"week" text NOT NULL,
	"reports_minutes" integer DEFAULT 0 NOT NULL,
	"official_pages_minutes" integer DEFAULT 0 NOT NULL,
	"affiliation_support_minutes" integer DEFAULT 0 NOT NULL,
	"curation_minutes" integer DEFAULT 0 NOT NULL,
	"other_minutes" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_time_entries_week_check" CHECK ("ops_time_entries"."week" ~ '^[0-9]{4}-W[0-9]{2}$'),
	CONSTRAINT "ops_time_entries_minutes_check" CHECK ("ops_time_entries"."reports_minutes" >= 0 and "ops_time_entries"."official_pages_minutes" >= 0 and "ops_time_entries"."affiliation_support_minutes" >= 0 and "ops_time_entries"."curation_minutes" >= 0 and "ops_time_entries"."other_minutes" >= 0
        and "ops_time_entries"."reports_minutes" + "ops_time_entries"."official_pages_minutes" + "ops_time_entries"."affiliation_support_minutes" + "ops_time_entries"."curation_minutes" + "ops_time_entries"."other_minutes" <= 10080),
	CONSTRAINT "ops_time_entries_note_check" CHECK ("ops_time_entries"."note" is null or char_length("ops_time_entries"."note") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_actor_hash_check";--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "actor_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "first_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "auto_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops_time_entries" ADD CONSTRAINT "ops_time_entries_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_time_entries_operator_week_key" ON "ops_time_entries" USING btree ("operator_id","week");--> statement-breakpoint
CREATE INDEX "ops_time_entries_week_idx" ON "ops_time_entries" USING btree ("week");--> statement-breakpoint
CREATE INDEX "reports_closed_at_idx" ON "reports" USING btree ("closed_at");--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_actor_hash_check" CHECK ("analytics_events"."actor_hash" is null or "analytics_events"."actor_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_first_action_check" CHECK ("reports"."first_action_at" is null or "reports"."first_action_at" >= "reports"."created_at");--> statement-breakpoint
-- C-10(ADR 0027) 기존 행 채우기. 첫 조치 = 배정·처리 중 이른 시각(다시 배정된 신고는 마지막 배정이라 근사).
UPDATE "reports" SET "first_action_at" = least("assigned_at", "closed_at") WHERE "first_action_at" IS NULL AND coalesce("assigned_at", "closed_at") IS NOT NULL;--> statement-breakpoint
-- 지금 임시 숨김인 글·댓글의 처리 전 신고: 숨김 시각을 모르므로 그 대상의 마지막 처리 전 신고 시각(숨김을 일으킨 신고)으로 채웁니다.
UPDATE "reports" r SET "auto_hidden_at" = x."at"
FROM (
  SELECT "target_key", max("created_at") AS "at" FROM "reports"
  WHERE "status" IN ('open', 'in_review')
    AND (("community_post_id" IN (SELECT "id" FROM "community_posts" WHERE "status" = 'auto_hidden'))
      OR ("community_comment_id" IN (SELECT "id" FROM "community_comments" WHERE "status" = 'auto_hidden')))
  GROUP BY "target_key"
) x
WHERE r."target_key" = x."target_key" AND r."status" IN ('open', 'in_review') AND r."auto_hidden_at" IS NULL;--> statement-breakpoint
-- 사용자 키 없는 이벤트(이전에는 이벤트마다 무작위 값의 HMAC)를 null로. 익명 대상 공감(reaction_added)은 props로 가릴 수 없어 그대로 둡니다(사람과 이어지지 않음).
UPDATE "analytics_events" SET "actor_hash" = NULL
WHERE "name"::text IN ('community_report_filed', 'community_auto_hidden', 'community_sanction_issued', 'archive_transfer_requested', 'archive_transfer_completed', 'course_qa_published')
   OR ("name"::text IN ('post_created', 'comment_created') AND "props"->>'mode' = 'anonymous');
