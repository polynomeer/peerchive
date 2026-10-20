-- T-10 (ADR 0010). 직접 고친 부분 두 가지(스키마 결과는 schema.ts·스냅샷과 같음):
-- 1) pg_trgm 확장: drizzle-kit은 확장을 만들지 않으므로 맨 앞에 추가했습니다(trgm GIN 인덱스·similarity 검색에 필요).
--    관리형 PostgreSQL에서는 이 확장이 허용 목록에 있어야 하고, migration 계정에 CREATE 권한이 있어야 합니다
--    (예: RDS·Cloud SQL·Supabase는 pg_trgm을 지원). 미리 만들어 두었다면 IF NOT EXISTS로 건너뜁니다.
-- 2) schools.name_key·courses.title_key: 기존 행이 있어도 적용되도록 nullable로 추가 → 근사값으로 채움 → NOT NULL.
--    (T-10 전에는 학교·과목을 만드는 API가 없었으므로 보통은 빈 테이블입니다.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."embargo_scope" AS ENUM('project', 'course_term');--> statement-breakpoint
CREATE TABLE "concept_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"parent_id" uuid,
	"merged_into" uuid,
	"merged_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_tags_slug_unique" UNIQUE("slug"),
	CONSTRAINT "concept_tags_slug_format_check" CHECK (char_length("concept_tags"."slug") between 1 and 40),
	CONSTRAINT "concept_tags_not_self_merged_check" CHECK ("concept_tags"."merged_into" is null or "concept_tags"."merged_into" <> "concept_tags"."id"),
	CONSTRAINT "concept_tags_not_self_parent_check" CHECK ("concept_tags"."parent_id" is null or "concept_tags"."parent_id" <> "concept_tags"."id")
);
--> statement-breakpoint
CREATE TABLE "course_concept_tags" (
	"course_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_concept_tags_pkey" PRIMARY KEY("course_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "embargoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "embargo_scope" NOT NULL,
	"project_id" uuid,
	"course_term_id" uuid,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embargoes_scope_target_check" CHECK (("embargoes"."scope" = 'project' and "embargoes"."project_id" is not null and "embargoes"."course_term_id" is null) or ("embargoes"."scope" = 'course_term' and "embargoes"."course_term_id" is not null and "embargoes"."project_id" is null)),
	CONSTRAINT "embargoes_reason_length_check" CHECK (char_length("embargoes"."reason") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "course_terms" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "course_terms" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "code_key" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "title_key" text;--> statement-breakpoint
UPDATE "courses" SET "title_key" = lower(regexp_replace("title", '[^[:alnum:]+#]+', '', 'g')), "code_key" = nullif(upper(regexp_replace(coalesce("code", ''), '[[:space:]._-]+', '', 'g')), '');--> statement-breakpoint
ALTER TABLE "courses" ALTER COLUMN "title_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "embargo_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "name_key" text;--> statement-breakpoint
UPDATE "schools" SET "name_key" = lower(regexp_replace("name", '[^[:alnum:]+#]+', '', 'g'));--> statement-breakpoint
ALTER TABLE "schools" ALTER COLUMN "name_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "concept_tags" ADD CONSTRAINT "concept_tags_parent_id_concept_tags_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."concept_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tags" ADD CONSTRAINT "concept_tags_merged_into_concept_tags_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."concept_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tags" ADD CONSTRAINT "concept_tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_concept_tags" ADD CONSTRAINT "course_concept_tags_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_concept_tags" ADD CONSTRAINT "course_concept_tags_tag_id_concept_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."concept_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_concept_tags" ADD CONSTRAINT "course_concept_tags_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_course_term_id_course_terms_id_fk" FOREIGN KEY ("course_term_id") REFERENCES "public"."course_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embargoes" ADD CONSTRAINT "embargoes_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_tags_slug_trgm_idx" ON "concept_tags" USING gin ("slug" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "concept_tags_merged_into_idx" ON "concept_tags" USING btree ("merged_into");--> statement-breakpoint
CREATE INDEX "course_concept_tags_tag_id_idx" ON "course_concept_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "embargoes_project_id_idx" ON "embargoes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "embargoes_course_term_id_idx" ON "embargoes" USING btree ("course_term_id");--> statement-breakpoint
ALTER TABLE "course_terms" ADD CONSTRAINT "course_terms_merged_into_course_terms_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."course_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_terms" ADD CONSTRAINT "course_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_merged_into_schools_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courses_school_code_key_idx" ON "courses" USING btree ("school_id","code_key");--> statement-breakpoint
CREATE INDEX "courses_title_key_trgm_idx" ON "courses" USING gin ("title_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "courses_merged_into_idx" ON "courses" USING btree ("merged_into");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_name_key_canonical_key" ON "schools" USING btree ("name_key") WHERE "schools"."merged_into" is null;--> statement-breakpoint
CREATE INDEX "schools_name_key_trgm_idx" ON "schools" USING gin ("name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "schools_merged_into_idx" ON "schools" USING btree ("merged_into");--> statement-breakpoint
ALTER TABLE "course_terms" ADD CONSTRAINT "course_terms_not_self_merged_check" CHECK ("course_terms"."merged_into" is null or "course_terms"."merged_into" <> "course_terms"."id");--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_not_self_merged_check" CHECK ("courses"."merged_into" is null or "courses"."merged_into" <> "courses"."id");--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_not_self_merged_check" CHECK ("schools"."merged_into" is null or "schools"."merged_into" <> "schools"."id");