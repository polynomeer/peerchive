CREATE TYPE "public"."persona_activity_source" AS ENUM('publication_release', 'senior_note', 'study_release', 'profile_post', 'community_post');--> statement-breakpoint
CREATE TABLE "persona_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"source_type" "persona_activity_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "persona_activities_source_key" UNIQUE("persona_id","source_type","source_id"),
	CONSTRAINT "persona_activities_item_kind_check" CHECK (("persona_activities"."source_type" = 'publication_release' and "persona_activities"."item_kind" = 'cases')
        or ("persona_activities"."source_type" in ('senior_note', 'study_release') and "persona_activities"."item_kind" = 'notes_and_studies')
        or ("persona_activities"."source_type" in ('profile_post', 'community_post') and "persona_activities"."item_kind" = 'posts'))
);
--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "persona_activities" ADD CONSTRAINT "persona_activities_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_activities_persona_created_idx" ON "persona_activities" USING btree ("persona_id","created_at" DESC NULLS LAST) WHERE "persona_activities"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "persona_activities_source_idx" ON "persona_activities" USING btree ("source_type","source_id");--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_comments_persona_idx" ON "community_comments" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "community_posts_persona_idx" ON "community_posts" USING btree ("persona_id");--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_persona_check" CHECK ("community_comments"."name_mode" <> 'anonymous' or "community_comments"."persona_id" is null);--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_persona_check" CHECK ("community_posts"."name_mode" <> 'anonymous' or "community_posts"."persona_id" is null);--> statement-breakpoint
-- S-02(ADR 0029): 아래는 drizzle 스키마가 표현하지 못해 손으로 둔 SQL입니다(스냅샷과 무관).
-- 1) 기존 글·댓글의 페르소나 귀속 채우기. "작성 시점의 페르소나"만 붙입니다:
--    - real: 글을 쓸 때 이미 실명 프로필(= 실명 페르소나, S-01이 프로필마다 만듦)이 있었으면(profiles.created_at <= 글 시각) 그 실명 페르소나.
--    - display: 붙이지 않습니다(null). 지금까지 표시명 글은 계정 표시 이름(= 실명 페르소나의 공개 이름)으로 보였으므로, 나중에 만든 표시명 페르소나에
--      붙이면 두 페르소나가 이어지고, 실명 페르소나에 붙이면 사용자가 고른 단계(표시명)를 넘어 실명 프로필로 끌어올리게 됩니다.
--    - anonymous: 항상 null(check).
UPDATE "community_posts" AS cp SET "persona_id" = p."id"
  FROM "personas" p JOIN "profiles" pr ON pr."persona_id" = p."id"
  WHERE cp."name_mode" = 'real' AND cp."persona_id" IS NULL AND p."user_id" = cp."author_id" AND p."kind" = 'real' AND pr."created_at" <= cp."created_at";--> statement-breakpoint
UPDATE "community_comments" AS cc SET "persona_id" = p."id"
  FROM "personas" p JOIN "profiles" pr ON pr."persona_id" = p."id"
  WHERE cc."name_mode" = 'real' AND cc."persona_id" IS NULL AND p."user_id" = cc."author_id" AND p."kind" = 'real' AND pr."created_at" <= cc."created_at";--> statement-breakpoint
-- 2) 글·댓글을 넣을 때 페르소나 확인: 페르소나의 주인 = 작성자, 페르소나 종류 = 이름 표시 방식. anonymous는 check가 null로 고정합니다.
CREATE FUNCTION "public"."community_persona_attribution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "community_posts_persona_attribution" BEFORE INSERT ON "community_posts" FOR EACH ROW EXECUTE FUNCTION "public"."community_persona_attribution_guard"();--> statement-breakpoint
CREATE TRIGGER "community_comments_persona_attribution" BEFORE INSERT ON "community_comments" FOR EACH ROW EXECUTE FUNCTION "public"."community_persona_attribution_guard"();--> statement-breakpoint
-- 3) 고정 열(0020)에 persona_id를 더합니다. 탈퇴 정리가 null로 비우는 것만 허용합니다(페르소나 행을 지우기 전에).
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
-- 4) 페르소나 활동 투영 검사(§8.3 불변조건 1: 0~1단계 글은 투영 경로 자체가 없음). 애플리케이션 규칙(@peerchive/domain
--    decidePersonaActivityProjection)과 같은 규칙을 원본 행으로 다시 확인합니다. SECURITY DEFINER: social 역할(커뮤니티 테이블 권한 없음)로
--    넣더라도 원본 확인은 테이블 주인 권한으로 하고, 결과는 통과/거부뿐이라 원본 내용이 새지 않습니다. 투영한 뒤에는 withdrawn_at만 바꿀 수 있습니다.
CREATE FUNCTION "public"."persona_activities_projection_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_id uuid;
  persona_kind text;
  ok boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.persona_id IS DISTINCT FROM OLD.persona_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.item_kind IS DISTINCT FROM OLD.item_kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'persona_activities rows are immutable except withdrawn_at' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.persona_id IS NULL THEN
    RETURN NEW; -- NOT NULL 제약이 거부합니다(23502).
  END IF;
  SELECT p.user_id, p.kind::text INTO owner_id, persona_kind FROM "public"."personas" p WHERE p.id = NEW.persona_id;
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'persona_activities: unknown persona' USING ERRCODE = '23503';
  END IF;
  CASE NEW.source_type::text
    WHEN 'community_post' THEN
      -- 이름 표시 방식 real·display, 작성 시점에 고정한 페르소나가 바로 이 페르소나, 게시 상태, listed 공간.
      ok := EXISTS (
        SELECT 1 FROM "public"."community_posts" cp JOIN "public"."community_spaces" s ON s.id = cp.space_id
        WHERE cp.id = NEW.source_id AND cp.name_mode::text IN ('real', 'display') AND cp.persona_id IS NOT NULL AND cp.persona_id = NEW.persona_id
          AND cp.status::text = 'published' AND s.discovery::text = 'listed'
      );
    WHEN 'senior_note' THEN
      -- 익명 노트는 없음. 계정 이름(name) 노트는 실명 페르소나, 표시명(display) 노트는 표시명 페르소나에만.
      ok := EXISTS (
        SELECT 1 FROM "public"."senior_notes" n
        WHERE n.id = NEW.source_id AND n.author_id = owner_id AND n.status::text = 'published'
          AND ((n.display_mode::text = 'name' AND persona_kind = 'real') OR (n.display_mode::text = 'display' AND persona_kind = 'display'))
      );
    WHEN 'publication_release', 'study_release' THEN
      -- 공개 사례 스냅샷에는 계정 이름·팀 정보가 있어 실명 페르소나에만(ADR 0028). 본인 동의가 있는 게시 중 release만.
      -- 스터디 release는 익명 스터디 방(스냅샷 studyNameMode = anonymous)이면 없음(ADR 0026 canLinkReleaseToPortfolio).
      ok := persona_kind = 'real' AND EXISTS (
        SELECT 1 FROM "public"."publication_candidates" c JOIN "public"."consents" k ON k.candidate_id = c.id
        WHERE c.id = NEW.source_id AND c.status::text = 'published' AND k.subject_user_id = owner_id AND k.status::text = 'granted'
          AND CASE WHEN NEW.source_type::text = 'study_release'
                THEN c.snapshot->>'kind' = 'study' AND coalesce(c.snapshot->>'studyNameMode', '') <> 'anonymous'
                ELSE coalesce(c.snapshot->>'kind', '') <> 'study' END
      );
    ELSE
      -- profile_post: 프로필 글 테이블은 S-05에서 생깁니다. 그때 이 함수에 규칙을 더합니다.
      ok := false;
  END CASE;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'persona_activities: % is not projectable to this persona', NEW.source_type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "persona_activities_projection_guard" BEFORE INSERT OR UPDATE ON "persona_activities" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_projection_guard"();--> statement-breakpoint
-- 5) social DB 역할(§8.3 "social 모듈이 쓰는 DB 역할에는 커뮤니티 글 테이블의 SELECT 권한을 주지 않음"). 로그인할 수 없는 역할이고, 권한 목록은
--    이 함수 하나에 둡니다(이후 팔로우·피드 테이블이 생기면 CREATE OR REPLACE로 더함). 역할은 클러스터 전역이라 이미 있으면 만들지 않고,
--    migration 사용자에게 CREATEROLE이 없으면 만들지 않고 넘어갑니다(운영: RUNBOOK §2 — 역할을 따로 만든 뒤 SELECT peerchive_apply_social_grants()).
CREATE FUNCTION "public"."peerchive_apply_social_grants"() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA "public" TO peerchive_social;
  GRANT SELECT ON "public"."personas", "public"."profiles", "public"."identity_links", "public"."persona_activities" TO peerchive_social;
  -- 계정 행은 공개 이름·상태만(이메일·실명·탈퇴 정리 정보 없음).
  GRANT SELECT ("id", "display_name", "status") ON "public"."users" TO peerchive_social;
  RETURN true;
END;
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    BEGIN
      CREATE ROLE peerchive_social NOLOGIN;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'peerchive_social role not created (no CREATEROLE); create it and run SELECT peerchive_apply_social_grants() (RUNBOOK)';
      WHEN duplicate_object THEN
        NULL;
    END;
  END IF;
  PERFORM "public"."peerchive_apply_social_grants"();
END;
$$;
