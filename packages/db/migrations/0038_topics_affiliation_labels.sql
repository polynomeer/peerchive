-- A-05 토픽·소속 표시 익명(ADR 0042): community_space_kind에 topic, community_name_mode에 affiliated_anonymous(1단계), 토픽 분류, 글·댓글의 작성 시점 소속 표시.
-- drizzle migrate는 처음부터 돌릴 때 모든 migration을 한 트랜잭션에서 실행하고, PostgreSQL은 ADD VALUE한 enum 값을 같은 트랜잭션에서 쓸 수 없습니다.
-- 그래서 이 migration의 check·트리거는 새 값을 모두 `::text`로 비교합니다(0033·0021과 같은 방식). 새로 만든 enum(affiliation_label_scope)은 같은 트랜잭션에서 써도 됩니다.
-- 새 열은 커뮤니티 구역 표에 있어 social DB 역할(peerchive_social)은 여전히 이 표들에 권한이 없습니다.
CREATE TYPE "public"."affiliation_label_scope" AS ENUM('institution', 'institution_kind', 'none');--> statement-breakpoint
CREATE TYPE "public"."topic_category" AS ENUM('career', 'grad_school', 'startup', 'military', 'campus_life', 'role');--> statement-breakpoint
ALTER TYPE "public"."community_name_mode" ADD VALUE 'affiliated_anonymous';--> statement-breakpoint
ALTER TYPE "public"."community_space_kind" ADD VALUE 'topic';--> statement-breakpoint
ALTER TABLE "community_comments" DROP CONSTRAINT "community_comments_persona_check";--> statement-breakpoint
ALTER TABLE "community_posts" DROP CONSTRAINT "community_posts_persona_check";--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "affiliation_id" uuid;--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "label_scope_requested" "affiliation_label_scope";--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "label_scope_applied" "affiliation_label_scope";--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "affiliation_label" text;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "affiliation_id" uuid;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "label_scope_requested" "affiliation_label_scope";--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "label_scope_applied" "affiliation_label_scope";--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "affiliation_label" text;--> statement-breakpoint
ALTER TABLE "community_spaces" ADD COLUMN "topic_category" "topic_category";--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_comments_affiliation_idx" ON "community_comments" USING btree ("affiliation_id");--> statement-breakpoint
CREATE INDEX "community_posts_affiliation_idx" ON "community_posts" USING btree ("affiliation_id");--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_affiliation_mode_check" CHECK (("community_comments"."name_mode"::text = 'affiliated_anonymous') = ("community_comments"."label_scope_requested" is not null and "community_comments"."label_scope_applied" is not null)
        and ("community_comments"."name_mode"::text = 'affiliated_anonymous' or ("community_comments"."affiliation_id" is null and "community_comments"."affiliation_label" is null)));--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_label_scope_check" CHECK ("community_comments"."label_scope_applied" is null or "community_comments"."label_scope_applied" = "community_comments"."label_scope_requested"
        or ("community_comments"."label_scope_requested" = 'institution' and "community_comments"."label_scope_applied" = 'institution_kind'));--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_affiliation_label_check" CHECK ("community_comments"."label_scope_applied" is null or (("community_comments"."label_scope_applied" = 'none') = ("community_comments"."affiliation_label" is null)
        and ("community_comments"."affiliation_label" is null or char_length("community_comments"."affiliation_label") between 1 and 100)));--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_persona_check" CHECK ("community_comments"."name_mode"::text not in ('anonymous', 'affiliated_anonymous') or "community_comments"."persona_id" is null);--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_affiliation_mode_check" CHECK (("community_posts"."name_mode"::text = 'affiliated_anonymous') = ("community_posts"."label_scope_requested" is not null and "community_posts"."label_scope_applied" is not null)
        and ("community_posts"."name_mode"::text = 'affiliated_anonymous' or ("community_posts"."affiliation_id" is null and "community_posts"."affiliation_label" is null)));--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_label_scope_check" CHECK ("community_posts"."label_scope_applied" is null or "community_posts"."label_scope_applied" = "community_posts"."label_scope_requested"
        or ("community_posts"."label_scope_requested" = 'institution' and "community_posts"."label_scope_applied" = 'institution_kind'));--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_affiliation_label_check" CHECK ("community_posts"."label_scope_applied" is null or (("community_posts"."label_scope_applied" = 'none') = ("community_posts"."affiliation_label" is null)
        and ("community_posts"."affiliation_label" is null or char_length("community_posts"."affiliation_label") between 1 and 100)));--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_persona_check" CHECK ("community_posts"."name_mode"::text not in ('anonymous', 'affiliated_anonymous') or "community_posts"."persona_id" is null);--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_topic_category_check" CHECK (("community_spaces"."kind"::text = 'topic') = ("community_spaces"."topic_category" is not null));--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_topic_check" CHECK (("community_spaces"."kind"::text <> 'topic' or ("community_spaces"."school_id" is null and "community_spaces"."current_name_mode"::text = 'affiliated_anonymous'))
        and ("community_spaces"."kind"::text = 'topic' or "community_spaces"."current_name_mode"::text <> 'affiliated_anonymous'));--> statement-breakpoint
-- 아래는 drizzle 스키마가 표현하지 못해 손으로 둔 SQL입니다(스냅샷과 무관).
-- 1) 글·댓글을 넣을 때: 소속 표시 익명은 토픽 공간에서만(댓글은 글의 공간), 페르소나는 주인·종류 확인(0027 그대로). 0~1단계 페르소나 null은 check가 맡습니다.
CREATE OR REPLACE FUNCTION "public"."community_persona_attribution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  space_kind text;
BEGIN
  IF NEW.name_mode::text = 'affiliated_anonymous' THEN
    IF TG_TABLE_NAME = 'community_posts' THEN
      SELECT s.kind::text INTO space_kind FROM "public"."community_spaces" s WHERE s.id = NEW.space_id;
    ELSE
      SELECT s.kind::text INTO space_kind FROM "public"."community_posts" cp JOIN "public"."community_spaces" s ON s.id = cp.space_id WHERE cp.id = NEW.post_id;
    END IF;
    IF space_kind IS DISTINCT FROM 'topic' THEN
      RAISE EXCEPTION '%.name_mode affiliated_anonymous is only allowed in topic spaces', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.persona_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.name_mode::text NOT IN ('real', 'display') OR NOT EXISTS (
    SELECT 1 FROM "public"."personas" p WHERE p.id = NEW.persona_id AND p.user_id = NEW.author_id AND p.kind::text = NEW.name_mode::text
  ) THEN
    RAISE EXCEPTION '%.persona_id must be the author''s persona of the same kind as name_mode', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- 2) 고정 열(0020·0027)에 소속 표시를 더합니다: 표시 범위·표시 문자열은 바꿀 수 없고, 소속 id(운영자 전용)는 탈퇴 정리가 null로 비우는 것만 허용합니다.
CREATE OR REPLACE FUNCTION "public"."community_frozen_columns_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'thread_aliases' THEN
    RAISE EXCEPTION 'thread_aliases rows are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.name_mode IS DISTINCT FROM OLD.name_mode OR NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION '%.name_mode/author_id are frozen at write time', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF NEW.persona_id IS DISTINCT FROM OLD.persona_id AND NEW.persona_id IS NOT NULL THEN
    RAISE EXCEPTION '%.persona_id is frozen at write time (it may only be cleared)', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF NEW.label_scope_requested IS DISTINCT FROM OLD.label_scope_requested OR NEW.label_scope_applied IS DISTINCT FROM OLD.label_scope_applied
    OR NEW.affiliation_label IS DISTINCT FROM OLD.affiliation_label THEN
    RAISE EXCEPTION '%.affiliation label is frozen at write time', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF NEW.affiliation_id IS DISTINCT FROM OLD.affiliation_id AND NEW.affiliation_id IS NOT NULL THEN
    RAISE EXCEPTION '%.affiliation_id is frozen at write time (it may only be cleared)', TG_TABLE_NAME USING ERRCODE = '23514';
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
$$;
-- 3) 페르소나 활동 투영(persona_activity_source_ok, 0031)은 community_post를 name_mode real·display + 작성 시점 persona_id로만 허용하므로
--    affiliated_anonymous 글은 바꾸지 않아도 투영 경로가 없습니다(테스트가 원시 SQL로도 확인).
