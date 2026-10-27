-- S-03 항목별 공개 범위·과제 수행 목록(ADR 0031). 복합 외래 키 대상 unique를 먼저 만들고(생성기 순서를 손으로 고침) 표를 만듭니다.
ALTER TABLE "personas" ADD CONSTRAINT "personas_id_kind_key" UNIQUE("id","kind");--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TYPE "public"."visibility_audience" AS ENUM('public', 'signed_in', 'same_institution', 'approved_followers', 'private');--> statement-breakpoint
CREATE TYPE "public"."visibility_item_kind" AS ENUM('project_list', 'posts', 'notes_and_studies', 'follow_lists');--> statement-breakpoint
CREATE TABLE "project_listings" (
	"project_member_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"persona_kind" "persona_kind" DEFAULT 'real' NOT NULL,
	"user_id" uuid NOT NULL,
	"shown_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "project_listings_pkey" PRIMARY KEY("project_member_id","persona_id"),
	CONSTRAINT "project_listings_real_persona_check" CHECK ("project_listings"."persona_kind" = 'real')
);
--> statement-breakpoint
CREATE TABLE "visibility_settings" (
	"persona_id" uuid NOT NULL,
	"item_kind" "visibility_item_kind" NOT NULL,
	"audience" "visibility_audience" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_settings_pkey" PRIMARY KEY("persona_id","item_kind"),
	CONSTRAINT "visibility_settings_follow_lists_check" CHECK ("visibility_settings"."item_kind" <> 'follow_lists' or "visibility_settings"."audience" in ('public', 'private'))
);
--> statement-breakpoint
ALTER TABLE "project_listings" ADD CONSTRAINT "project_listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_listings" ADD CONSTRAINT "project_listings_member_fk" FOREIGN KEY ("project_member_id","user_id") REFERENCES "public"."project_members"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_listings" ADD CONSTRAINT "project_listings_persona_fk" FOREIGN KEY ("persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_listings" ADD CONSTRAINT "project_listings_persona_kind_fk" FOREIGN KEY ("persona_id","persona_kind") REFERENCES "public"."personas"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_settings" ADD CONSTRAINT "visibility_settings_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_listings_persona_idx" ON "project_listings" USING btree ("persona_id") WHERE "project_listings"."hidden_at" is null;--> statement-breakpoint
-- social DB 역할의 권한 목록(migration 0027 peerchive_apply_social_grants)에 과제 수행 목록 읽기 경로를 더합니다. 커뮤니티 테이블은 여전히 0건입니다.
-- 새 두 표는 표 전체 SELECT, 과제·학기·과목·엠바고·학교 인증은 목록 계산에 쓰는 열만 SELECT(로그·파일·설명·다른 멤버의 역할·메일 해시 없음).
CREATE OR REPLACE FUNCTION "public"."peerchive_apply_social_grants"() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA "public" TO peerchive_social;
  GRANT SELECT ON "public"."personas", "public"."profiles", "public"."identity_links", "public"."persona_activities",
    "public"."visibility_settings", "public"."project_listings" TO peerchive_social;
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
