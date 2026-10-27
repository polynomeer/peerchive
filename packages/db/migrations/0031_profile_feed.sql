CREATE TYPE "public"."profile_post_status" AS ENUM('published', 'deleted', 'hidden');--> statement-breakpoint
CREATE TABLE "profile_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"media_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "profile_post_status" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "profile_posts_body_check" CHECK (("profile_posts"."status" = 'deleted' and "profile_posts"."body" = '') or ("profile_posts"."status" <> 'deleted' and char_length("profile_posts"."body") between 1 and 500)),
	CONSTRAINT "profile_posts_deleted_check" CHECK (("profile_posts"."status" = 'deleted') = ("profile_posts"."deleted_at" is not null)),
	CONSTRAINT "profile_posts_media_check" CHECK (cardinality("profile_posts"."media_version_ids") = 0)
);
--> statement-breakpoint
ALTER TABLE "profile_posts" ADD CONSTRAINT "profile_posts_persona_fk" FOREIGN KEY ("persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_posts_persona_created_idx" ON "profile_posts" USING btree ("persona_id","created_at" DESC NULLS LAST) WHERE "profile_posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX "profile_posts_user_idx" ON "profile_posts" USING btree ("user_id");--> statement-breakpoint
-- S-05(ADR 0035): 아래는 drizzle 스키마가 표현하지 못해 손으로 둔 SQL입니다(스냅샷과 무관).
-- 1) 원천 확인을 한 함수로: "이 원천을 이 페르소나의 활동으로 지금 보여도 되는가". 투영 트리거(0027)의 규칙을 그대로 옮기고 프로필 글을 더했습니다.
--    투영(INSERT)·되살리기(withdrawn_at → null)·읽기 시점 재확인(persona_activity_cards)이 모두 이 함수를 거칩니다. SECURITY DEFINER: social 역할로
--    부르는 읽기 경로에서도 원본 확인은 테이블 주인 권한으로 하고, 결과는 참/거짓뿐입니다.
CREATE FUNCTION "public"."persona_activity_source_ok"(p_persona uuid, p_type "public"."persona_activity_source", p_source uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_id uuid;
  persona_kind text;
BEGIN
  SELECT p.user_id, p.kind::text INTO owner_id, persona_kind FROM "public"."personas" p WHERE p.id = p_persona;
  IF owner_id IS NULL THEN
    RETURN false;
  END IF;
  CASE p_type::text
    WHEN 'community_post' THEN
      -- 이름 표시 방식 real·display, 작성 시점에 고정한 페르소나가 바로 이 페르소나, 게시 상태, listed 공간.
      RETURN EXISTS (
        SELECT 1 FROM "public"."community_posts" cp JOIN "public"."community_spaces" s ON s.id = cp.space_id
        WHERE cp.id = p_source AND cp.name_mode::text IN ('real', 'display') AND cp.persona_id IS NOT NULL AND cp.persona_id = p_persona
          AND cp.status::text = 'published' AND s.discovery::text = 'listed'
      );
    WHEN 'senior_note' THEN
      -- 익명 노트는 없음. 계정 이름(name) 노트는 실명 페르소나, 표시명(display) 노트는 표시명 페르소나에만.
      RETURN EXISTS (
        SELECT 1 FROM "public"."senior_notes" n
        WHERE n.id = p_source AND n.author_id = owner_id AND n.status::text = 'published'
          AND ((n.display_mode::text = 'name' AND persona_kind = 'real') OR (n.display_mode::text = 'display' AND persona_kind = 'display'))
      );
    WHEN 'publication_release', 'study_release' THEN
      -- 실명 페르소나에만(ADR 0028), 본인 동의가 있는 게시 중 release만, 익명 스터디 방 release는 없음(ADR 0026).
      RETURN persona_kind = 'real' AND EXISTS (
        SELECT 1 FROM "public"."publication_candidates" c JOIN "public"."consents" k ON k.candidate_id = c.id
        WHERE c.id = p_source AND c.status::text = 'published' AND k.subject_user_id = owner_id AND k.status::text = 'granted'
          AND CASE WHEN p_type::text = 'study_release'
                THEN c.snapshot->>'kind' = 'study' AND coalesce(c.snapshot->>'studyNameMode', '') <> 'anonymous'
                ELSE coalesce(c.snapshot->>'kind', '') <> 'study' END
      );
    WHEN 'profile_post' THEN
      -- 자기 페르소나의 게시 중인 글만.
      RETURN EXISTS (SELECT 1 FROM "public"."profile_posts" pp WHERE pp.id = p_source AND pp.persona_id = p_persona AND pp.status::text = 'published');
    ELSE
      RETURN false;
  END CASE;
END;
$$;--> statement-breakpoint
-- 2) 투영 트리거(0027)를 위 함수로 바꿉니다. 투영한 뒤에는 withdrawn_at만 바뀌고, 거둔 행을 되살릴 때(null로)는 원천을 다시 확인합니다.
CREATE OR REPLACE FUNCTION "public"."persona_activities_projection_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.persona_id IS DISTINCT FROM OLD.persona_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.item_kind IS DISTINCT FROM OLD.item_kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'persona_activities rows are immutable except withdrawn_at' USING ERRCODE = '23514';
    END IF;
    IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL
      AND NOT "public"."persona_activity_source_ok"(NEW.persona_id, NEW.source_type, NEW.source_id) THEN
      RAISE EXCEPTION 'persona_activities: % cannot be restored to this persona', NEW.source_type USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.persona_id IS NULL THEN
    RETURN NEW; -- NOT NULL 제약이 거부합니다(23502).
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."personas" p WHERE p.id = NEW.persona_id) THEN
    RAISE EXCEPTION 'persona_activities: unknown persona' USING ERRCODE = '23503';
  END IF;
  IF NOT "public"."persona_activity_source_ok"(NEW.persona_id, NEW.source_type, NEW.source_id) THEN
    RAISE EXCEPTION 'persona_activities: % is not projectable to this persona', NEW.source_type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- 3) 거두기·되살리기(§6.7.1 "숨김·삭제·철회·이름 표시 재선택 시 같은 트랜잭션의 outbox로 withdrawn_at을 채움"): 원본 행의 상태가 바뀌는
--    **같은 트랜잭션**에서 트리거가 withdrawn_at을 채웁니다. 웹·worker·운영 SQL 어느 경로로 바꿔도 빠지지 않습니다(worker 지연 없음).
--    공개 상태로 돌아오면(운영 숨김 해제·고친 노트 다시 게시·listed로 되돌림) 원천을 다시 확인해 통과하는 행만 되살립니다.
CREATE FUNCTION "public"."persona_activities_sync"(p_type "public"."persona_activity_source", p_source uuid, p_visible boolean) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF p_visible THEN
    UPDATE "public"."persona_activities" a SET withdrawn_at = NULL
      WHERE a.source_type = p_type AND a.source_id = p_source AND a.withdrawn_at IS NOT NULL
        AND "public"."persona_activity_source_ok"(a.persona_id, a.source_type, a.source_id);
  ELSE
    UPDATE "public"."persona_activities" a SET withdrawn_at = now()
      WHERE a.source_type = p_type AND a.source_id = p_source AND a.withdrawn_at IS NULL;
  END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."persona_activities_source_status_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'community_posts' THEN
      PERFORM "public"."persona_activities_sync"('community_post', NEW.id, NEW.status::text = 'published');
    WHEN 'senior_notes' THEN
      PERFORM "public"."persona_activities_sync"('senior_note', NEW.id, NEW.status::text = 'published');
    WHEN 'profile_posts' THEN
      PERFORM "public"."persona_activities_sync"('profile_post', NEW.id, NEW.status::text = 'published');
    WHEN 'publication_candidates' THEN
      PERFORM "public"."persona_activities_sync"('publication_release', NEW.id, NEW.status::text = 'published');
      PERFORM "public"."persona_activities_sync"('study_release', NEW.id, NEW.status::text = 'published');
    WHEN 'consents' THEN
      -- 동의 철회: 그 당사자의 페르소나에 붙은 이 release의 활동만 거둡니다(release 자체의 철회는 publication_candidates 트리거).
      IF OLD.status::text = 'granted' AND NEW.status::text <> 'granted' THEN
        UPDATE "public"."persona_activities" a SET withdrawn_at = now()
          WHERE a.source_type IN ('publication_release', 'study_release') AND a.source_id = NEW.candidate_id AND a.withdrawn_at IS NULL
            AND a.persona_id IN (SELECT p.id FROM "public"."personas" p WHERE p.user_id = NEW.subject_user_id);
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "community_posts_persona_activity_sync" AFTER UPDATE OF "status" ON "community_posts" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_source_status_sync"();--> statement-breakpoint
CREATE TRIGGER "senior_notes_persona_activity_sync" AFTER UPDATE OF "status" ON "senior_notes" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_source_status_sync"();--> statement-breakpoint
CREATE TRIGGER "profile_posts_persona_activity_sync" AFTER UPDATE OF "status" ON "profile_posts" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_source_status_sync"();--> statement-breakpoint
CREATE TRIGGER "publication_candidates_persona_activity_sync" AFTER UPDATE OF "status" ON "publication_candidates" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_source_status_sync"();--> statement-breakpoint
CREATE TRIGGER "consents_persona_activity_sync" AFTER UPDATE OF "status" ON "consents" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_source_status_sync"();--> statement-breakpoint
-- 공간 노출이 listed를 떠나면 그 공간 글의 활동을 거두고, listed로 돌아오면 원천을 다시 확인해 되살립니다.
CREATE FUNCTION "public"."persona_activities_space_discovery_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.discovery IS NOT DISTINCT FROM OLD.discovery THEN
    RETURN NULL;
  END IF;
  IF NEW.discovery::text = 'listed' THEN
    UPDATE "public"."persona_activities" a SET withdrawn_at = NULL
      WHERE a.source_type = 'community_post' AND a.withdrawn_at IS NOT NULL
        AND a.source_id IN (SELECT cp.id FROM "public"."community_posts" cp WHERE cp.space_id = NEW.id)
        AND "public"."persona_activity_source_ok"(a.persona_id, a.source_type, a.source_id);
  ELSE
    UPDATE "public"."persona_activities" a SET withdrawn_at = now()
      WHERE a.source_type = 'community_post' AND a.withdrawn_at IS NULL
        AND a.source_id IN (SELECT cp.id FROM "public"."community_posts" cp WHERE cp.space_id = NEW.id);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "community_spaces_persona_activity_sync" AFTER UPDATE OF "discovery" ON "community_spaces" FOR EACH ROW EXECUTE FUNCTION "public"."persona_activities_space_discovery_sync"();--> statement-breakpoint
-- 4) 읽기 시점 재확인(§11.3 "항목마다 canViewPersonaItem과 원본 상태를 다시 확인")과 카드 내용. social 모듈은 커뮤니티 글·선배 노트·공개 후보
--    테이블을 읽을 수 없으므로(§8.3), 활동 id 목록을 넘기면 **지금 보여도 되는 것만** 카드 한 줄씩 돌려주는 좁은 함수 하나를 둡니다.
--    - 모든 원천: persona_activity_source_ok(투영 규칙 그대로: 게시 상태·동의·익명 아님·작성 시점 페르소나·listed) + 거두지 않음 + 페르소나·계정·프로필 공개 상태.
--      worker가 늦어 withdrawn_at이 아직 비어 있어도 원본이 숨김·삭제·철회면 여기서 빠집니다.
--    - 커뮤니티 글은 보는 사람이 그 공간을 읽을 수 있을 때만(§8.3 "listed 공간의 글이라도 열람자가 canReadSpace를 통과할 때만"): @peerchive/domain
--      canReadSpace와 같은 규칙(active 계정, 공식 페이지는 운영자 또는 그 학교 인증, 사용자·스터디 방은 active 멤버 + 학교 자격). 비로그인(null)은 0건.
--    - 공개 사례·스터디 release는 지금 그 공개의 게시 중 release일 때만(공개 URL이 열리는 것).
--    - 카드 내용: 프로필 글 본문 / 커뮤니티 글 제목·공간 이름 / 선배 노트의 과목 이름·학기(본문·원 글 연결 없음) / release 제목·한 줄 요약·학기.
--      작성자 id·원 글 id·이메일은 싣지 않습니다. 공개 범위(canViewPersonaItem)·차단·뮤트는 호출하는 social 모듈이 먼저 거릅니다.
CREATE FUNCTION "public"."persona_activity_cards"(p_viewer uuid, p_ids uuid[])
  RETURNS TABLE(activity_id uuid, title text, body text, href text, context text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH act AS (
    SELECT a.id, a.persona_id, a.source_type::text AS source_type, a.source_id
    FROM "public"."persona_activities" a
      JOIN "public"."personas" p ON p.id = a.persona_id
      JOIN "public"."users" u ON u.id = p.user_id
      JOIN "public"."profiles" pr ON pr.persona_id = p.id
    WHERE a.id = ANY(p_ids) AND a.withdrawn_at IS NULL AND p.status::text = 'active' AND u.status::text = 'active' AND pr.hidden_at IS NULL
      AND "public"."persona_activity_source_ok"(a.persona_id, a.source_type, a.source_id)
  ),
  viewer_schools AS (
    SELECT coalesce(sc.merged_into, sc.id) AS school_id
    FROM "public"."institution_affiliations" ia JOIN "public"."schools" sc ON sc.id = ia.school_id
    WHERE p_viewer IS NOT NULL AND ia.user_id = p_viewer AND ia.status::text = 'active'
  ),
  viewer AS (
    SELECT (p_viewer IS NOT NULL AND EXISTS (SELECT 1 FROM "public"."users" vu WHERE vu.id = p_viewer AND vu.status::text = 'active')) AS active,
           EXISTS (SELECT 1 FROM "public"."operators" o WHERE o.user_id = p_viewer AND o.revoked_at IS NULL) AS operator,
           EXISTS (SELECT 1 FROM viewer_schools) AS any_school
  )
  SELECT act.id, NULL::text, pp.body, NULL::text, NULL::text
    FROM act JOIN "public"."profile_posts" pp ON pp.id = act.source_id
    WHERE act.source_type = 'profile_post'
  UNION ALL
  SELECT act.id, cp.title, NULL::text, '/community/p/' || cp.id::text, s.name
    FROM act JOIN "public"."community_posts" cp ON cp.id = act.source_id
      JOIN "public"."community_spaces" s ON s.id = cp.space_id
      LEFT JOIN "public"."schools" ssc ON ssc.id = s.school_id
      CROSS JOIN viewer v
    WHERE act.source_type = 'community_post' AND v.active AND (
      (s.kind::text IN ('official_school', 'official_department')
        AND (v.operator OR (s.school_id IS NOT NULL AND coalesce(ssc.merged_into, ssc.id) IN (SELECT school_id FROM viewer_schools))))
      OR (s.kind::text IN ('user_room', 'study_room')
        AND EXISTS (SELECT 1 FROM "public"."space_memberships" m WHERE m.space_id = s.id AND m.user_id = p_viewer AND m.status::text = 'active')
        AND (CASE WHEN s.school_id IS NULL THEN v.any_school ELSE coalesce(ssc.merged_into, ssc.id) IN (SELECT school_id FROM viewer_schools) END))
    )
  UNION ALL
  SELECT act.id, coalesce((SELECT cc.title FROM "public"."courses" cc WHERE cc.id = c.merged_into), c.title), NULL::text, '/c/' || n.course_id::text, n.term_label
    FROM act JOIN "public"."senior_notes" n ON n.id = act.source_id
      JOIN "public"."courses" c ON c.id = n.course_id
    WHERE act.source_type = 'senior_note'
  UNION ALL
  SELECT act.id, rc.snapshot->>'title', left(rc.snapshot->>'summary', 200), '/p/' || pub.slug, rc.term_label
    FROM act JOIN "public"."publication_candidates" rc ON rc.id = act.source_id
      JOIN "public"."publications" pub ON pub.id = rc.publication_id
    WHERE act.source_type IN ('publication_release', 'study_release') AND pub.status::text = 'published' AND pub.current_release_id = rc.id
$$;--> statement-breakpoint
-- SECURITY DEFINER 함수는 기본 PUBLIC 실행 권한을 거두고 필요한 역할에만 줍니다(테이블 주인은 그대로 부를 수 있음).
REVOKE ALL ON FUNCTION "public"."persona_activity_source_ok"(uuid, "public"."persona_activity_source", uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."persona_activity_cards"(uuid, uuid[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."persona_activities_sync"("public"."persona_activity_source", uuid, boolean) FROM PUBLIC;--> statement-breakpoint
-- 5) social DB 역할(0027~0030)에 프로필 글 읽기와 카드 함수 실행을 더합니다. 커뮤니티 테이블은 여전히 0건이고 원천 테이블(선배 노트·공개 후보)도
--    읽지 않습니다 — 원본 상태와 카드 내용은 persona_activity_cards만 줍니다.
CREATE OR REPLACE FUNCTION "public"."peerchive_apply_social_grants"() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA "public" TO peerchive_social;
  GRANT SELECT ON "public"."personas", "public"."profiles", "public"."identity_links", "public"."persona_activities",
    "public"."visibility_settings", "public"."project_listings", "public"."follows", "public"."blocks", "public"."mutes",
    "public"."social_links", "public"."profile_posts" TO peerchive_social;
  -- 계정 행은 공개 이름·상태만(이메일·실명·탈퇴 정리 정보 없음).
  GRANT SELECT ("id", "display_name", "status") ON "public"."users" TO peerchive_social;
  -- 과제 수행 목록(S-03): 과목·학기·제목과 엠바고·익명 스터디 판정에 필요한 열만.
  GRANT SELECT ("id", "project_id", "user_id", "status") ON "public"."project_members" TO peerchive_social;
  GRANT SELECT ("id", "title", "kind", "course_term_id", "embargo_until", "study_name_mode") ON "public"."projects" TO peerchive_social;
  GRANT SELECT ("id", "course_id", "year", "semester") ON "public"."course_terms" TO peerchive_social;
  GRANT SELECT ("id", "title", "merged_into") ON "public"."courses" TO peerchive_social;
  GRANT SELECT ("project_id", "course_term_id", "until", "revoked_at") ON "public"."embargoes" TO peerchive_social;
  -- same_institution 판정(S-03): 사용자·정본 학교·상태만(메일 해시·도메인·학과 없음).
  GRANT SELECT ("user_id", "school_id", "status") ON "public"."institution_affiliations" TO peerchive_social;
  GRANT SELECT ("id", "merged_into") ON "public"."schools" TO peerchive_social;
  -- S-05: 활동 카드(읽기 시점 원본 재확인). 이 함수만 원천 테이블을 테이블 주인 권한으로 읽습니다.
  GRANT EXECUTE ON FUNCTION "public"."persona_activity_cards"(uuid, uuid[]) TO peerchive_social;
  RETURN true;
END;
$$;--> statement-breakpoint
SELECT "public"."peerchive_apply_social_grants"();
