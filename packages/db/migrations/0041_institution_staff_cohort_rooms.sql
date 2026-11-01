-- I-02 기관 페이지·기수 방·기관 운영진(ADR 0044).
-- 1) institution_staff: 운영자가 지정·해제하는 기관 운영진(기관·사람마다 열린 행 하나, 해제는 revoked_at으로 남김).
-- 2) community_spaces.cohort_id: 기수 방(사용자 방 + 기관 연결만, 기수마다 보관되지 않은 방 하나).
-- enum 값을 더하지 않으므로 처음부터 한 트랜잭션에서 migrate해도 ADD VALUE 문제가 없습니다(check는 기존 관례대로 ::text 비교).
CREATE TABLE "institution_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "institution_staff_revoked_check" CHECK ("institution_staff"."revoked_at" is not null or "institution_staff"."revoked_by" is null)
);
--> statement-breakpoint
ALTER TABLE "community_spaces" ADD COLUMN "cohort_id" uuid;--> statement-breakpoint
ALTER TABLE "institution_staff" ADD CONSTRAINT "institution_staff_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_staff" ADD CONSTRAINT "institution_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_staff" ADD CONSTRAINT "institution_staff_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_staff" ADD CONSTRAINT "institution_staff_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institution_staff_open_key" ON "institution_staff" USING btree ("school_id","user_id") WHERE "institution_staff"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "institution_staff_user_id_idx" ON "institution_staff" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_cohort_id_institution_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."institution_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_spaces_cohort_room_key" ON "community_spaces" USING btree ("cohort_id") WHERE "community_spaces"."cohort_id" is not null and "community_spaces"."status" <> 'archived';--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_cohort_check" CHECK ("community_spaces"."cohort_id" is null or ("community_spaces"."kind"::text = 'user_room' and "community_spaces"."school_id" is not null));