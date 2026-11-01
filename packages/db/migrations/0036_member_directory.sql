-- A-03 동문회·OB 방 멤버 명부 동의(ADR 0040): directory_entries. 동의한 멤버만 행이 있고 철회·나가기 때 행을 지우므로 withdrawn_at은 두지 않습니다.
-- 새 표는 커뮤니티 구역이라 social DB 역할(peerchive_social)에 권한을 주지 않습니다(peerchive_apply_social_grants는 표를 이름으로만 허용하므로 다시 정의하지 않음).
CREATE TABLE "directory_entries" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cohort_label" text,
	"current_work" text,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_method" text,
	"consented_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_entries_pkey" PRIMARY KEY("space_id","user_id"),
	CONSTRAINT "directory_entries_cohort_check" CHECK ("directory_entries"."cohort_label" is null or char_length("directory_entries"."cohort_label") between 1 and 20),
	CONSTRAINT "directory_entries_current_work_check" CHECK ("directory_entries"."current_work" is null or char_length("directory_entries"."current_work") between 1 and 60),
	CONSTRAINT "directory_entries_interests_check" CHECK (cardinality("directory_entries"."interests") <= 5),
	CONSTRAINT "directory_entries_contact_check" CHECK ("directory_entries"."contact_method" is null or char_length("directory_entries"."contact_method") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "directory_entries" ADD CONSTRAINT "directory_entries_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_entries" ADD CONSTRAINT "directory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_entries_space_consented_idx" ON "directory_entries" USING btree ("space_id","consented_at");--> statement-breakpoint
CREATE INDEX "directory_entries_user_id_idx" ON "directory_entries" USING btree ("user_id");