-- A-01 동문회·OB 방(ADR 0038): 사용자 방 템플릿(community_spaces.template), 방별 프로필(room_profiles), 기수 변경 이력(room_profile_cohort_changes).
-- 새 표는 커뮤니티 구역이라 social DB 역할(peerchive_social)에 권한을 주지 않습니다(peerchive_apply_social_grants는 표를 이름으로만 허용하므로 다시 정의하지 않음).
-- 새 enum 타입을 만들므로 ALTER TYPE ADD VALUE를 쓰지 않습니다(check는 ::text로 비교).
CREATE TYPE "public"."community_space_template" AS ENUM('general', 'alumni');--> statement-breakpoint
CREATE TABLE "room_profile_cohort_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"changed_by" uuid,
	"from_label" text,
	"to_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_profile_cohort_changes_changed_check" CHECK ("room_profile_cohort_changes"."from_label" is distinct from "room_profile_cohort_changes"."to_label")
);
--> statement-breakpoint
CREATE TABLE "room_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text,
	"badges" text[] DEFAULT '{}'::text[] NOT NULL,
	"cohort_label" text,
	"bio" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_profiles_display_name_check" CHECK ("room_profiles"."display_name" is null or char_length("room_profiles"."display_name") between 1 and 30),
	CONSTRAINT "room_profiles_cohort_label_check" CHECK ("room_profiles"."cohort_label" is null or char_length("room_profiles"."cohort_label") between 1 and 20),
	CONSTRAINT "room_profiles_bio_check" CHECK ("room_profiles"."bio" is null or char_length("room_profiles"."bio") between 1 and 200),
	CONSTRAINT "room_profiles_badges_check" CHECK ("room_profiles"."badges" <@ array['current', 'ob', 'alumni']::text[] and not ("room_profiles"."badges" @> array['current', 'ob']::text[]))
);
--> statement-breakpoint
ALTER TABLE "community_spaces" ADD COLUMN "template" "community_space_template" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_profile_cohort_changes" ADD CONSTRAINT "room_profile_cohort_changes_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_profile_cohort_changes" ADD CONSTRAINT "room_profile_cohort_changes_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_profile_cohort_changes" ADD CONSTRAINT "room_profile_cohort_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_profiles" ADD CONSTRAINT "room_profiles_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_profiles" ADD CONSTRAINT "room_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_profile_cohort_changes_subject_idx" ON "room_profile_cohort_changes" USING btree ("space_id","subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "room_profile_cohort_changes_changed_by_idx" ON "room_profile_cohort_changes" USING btree ("changed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "room_profiles_space_user_key" ON "room_profiles" USING btree ("space_id","user_id");--> statement-breakpoint
CREATE INDEX "room_profiles_user_id_idx" ON "room_profiles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_template_check" CHECK ("community_spaces"."template"::text = 'general' or "community_spaces"."kind"::text = 'user_room');