-- S-06 소셜 링크·되돌림 확인(ADR 0034). 링크는 페르소나마다 따로이고, (persona_id, user_id) 복합 외래 키가 사용자 사본 = 페르소나 주인을 보장하며,
-- (user_id, url) 유일 키가 같은 사용자의 다른 페르소나에 같은 주소를 거는 것을 막습니다. 확인은 worker의 링크 수집기만 합니다.
CREATE TYPE "public"."social_link_check_result" AS ENUM('found', 'missing', 'fetch_failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."social_link_provider" AS ENUM('github', 'blog', 'linkedin', 'instagram', 'youtube', 'other');--> statement-breakpoint
CREATE TYPE "public"."social_link_verification" AS ENUM('unverified', 'verified', 'lost');--> statement-breakpoint
CREATE TABLE "social_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "social_link_provider" NOT NULL,
	"url" text NOT NULL,
	"verification" "social_link_verification" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_result" "social_link_check_result",
	"check_failures" integer DEFAULT 0 NOT NULL,
	"verify_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_links_user_url_key" UNIQUE("user_id","url"),
	CONSTRAINT "social_links_url_check" CHECK ("social_links"."url" like 'https://%' and char_length("social_links"."url") <= 300),
	CONSTRAINT "social_links_verified_at_check" CHECK (("social_links"."verification" = 'verified') = ("social_links"."verified_at" is not null)),
	CONSTRAINT "social_links_failures_check" CHECK ("social_links"."check_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "social_links" ADD CONSTRAINT "social_links_persona_fk" FOREIGN KEY ("persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_links_persona_idx" ON "social_links" USING btree ("persona_id","created_at");--> statement-breakpoint
CREATE INDEX "social_links_recheck_idx" ON "social_links" USING btree ("last_checked_at") WHERE "social_links"."verification" = 'verified';;--> statement-breakpoint
-- social DB 역할의 권한 목록(migration 0027·0028·0029 peerchive_apply_social_grants)에 소셜 링크 읽기를 더합니다. 커뮤니티 테이블은 여전히 0건입니다.
-- 공개 프로필은 서비스·주소·확인 여부만 내보내지만, 역할에는 표 전체 SELECT를 줍니다(사용자 사본 열은 판정에만 씀). 쓰기 권한은 주지 않습니다.
CREATE OR REPLACE FUNCTION "public"."peerchive_apply_social_grants"() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA "public" TO peerchive_social;
  GRANT SELECT ON "public"."personas", "public"."profiles", "public"."identity_links", "public"."persona_activities",
    "public"."visibility_settings", "public"."project_listings", "public"."follows", "public"."blocks", "public"."mutes",
    "public"."social_links" TO peerchive_social;
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
  RETURN true;
END;
$$;--> statement-breakpoint
SELECT "public"."peerchive_apply_social_grants"();
