-- S-04 팔로우·비공개 계정·차단·뮤트(ADR 0033). 세 표 모두 (persona_id, user_id) 복합 외래 키(대상 unique personas_id_user_key는 0026에 있음)와
-- 사용자 사본 열의 check로 자기 페르소나(같은 사용자의 다른 페르소나 포함) 팔로우·차단·뮤트를 DB가 막습니다.
CREATE TYPE "public"."block_scope" AS ENUM('origin_persona', 'all_personas');--> statement-breakpoint
CREATE TYPE "public"."follow_status" AS ENUM('pending', 'active');--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"origin_persona_id" uuid NOT NULL,
	"blocked_persona_id" uuid NOT NULL,
	"scope" "block_scope" DEFAULT 'origin_persona' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_origin_target_key" UNIQUE("blocker_user_id","origin_persona_id","blocked_persona_id"),
	CONSTRAINT "blocks_not_self_check" CHECK ("blocks"."blocker_user_id" <> "blocks"."blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_persona_id" uuid NOT NULL,
	"follower_user_id" uuid NOT NULL,
	"followee_persona_id" uuid NOT NULL,
	"followee_user_id" uuid NOT NULL,
	"status" "follow_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "follows_pair_key" UNIQUE("follower_persona_id","followee_persona_id"),
	CONSTRAINT "follows_not_self_check" CHECK ("follows"."follower_user_id" <> "follows"."followee_user_id"),
	CONSTRAINT "follows_approved_check" CHECK (("follows"."status" = 'active') = ("follows"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"muter_user_id" uuid NOT NULL,
	"muted_persona_id" uuid NOT NULL,
	"muted_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutes_pair_key" UNIQUE("muter_user_id","muted_persona_id"),
	CONSTRAINT "mutes_not_self_check" CHECK ("mutes"."muter_user_id" <> "mutes"."muted_user_id")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_origin_persona_fk" FOREIGN KEY ("origin_persona_id","blocker_user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_persona_fk" FOREIGN KEY ("blocked_persona_id","blocked_user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_persona_fk" FOREIGN KEY ("follower_persona_id","follower_user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_persona_fk" FOREIGN KEY ("followee_persona_id","followee_user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muter_user_id_users_id_fk" FOREIGN KEY ("muter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muted_persona_fk" FOREIGN KEY ("muted_persona_id","muted_user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_user_idx" ON "blocks" USING btree ("blocked_user_id","blocker_user_id");--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_persona_id","status");--> statement-breakpoint
CREATE INDEX "follows_follower_user_idx" ON "follows" USING btree ("follower_user_id");--> statement-breakpoint
CREATE INDEX "follows_followee_user_idx" ON "follows" USING btree ("followee_user_id");--> statement-breakpoint
-- social DB 역할의 권한 목록(migration 0027·0028 peerchive_apply_social_grants)에 팔로우·차단·뮤트 읽기를 더합니다. 커뮤니티 테이블은 여전히 0건입니다.
-- 세 표는 표 전체 SELECT(사용자 사본 열은 판정에만 쓰고 응답에 싣지 않음). 쓰기 권한은 주지 않습니다.
CREATE OR REPLACE FUNCTION "public"."peerchive_apply_social_grants"() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'peerchive_social') THEN
    RETURN false;
  END IF;
  GRANT USAGE ON SCHEMA "public" TO peerchive_social;
  GRANT SELECT ON "public"."personas", "public"."profiles", "public"."identity_links", "public"."persona_activities",
    "public"."visibility_settings", "public"."project_listings", "public"."follows", "public"."blocks", "public"."mutes" TO peerchive_social;
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
