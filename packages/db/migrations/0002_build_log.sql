-- T-04 빌드 로그. 복합 외래 키(log_revisions_entry_tag_fk)가 참조할 UNIQUE(id, tag)를 먼저 만들도록 생성 순서를 조정했습니다.
DROP INDEX "log_entries_project_id_idx";--> statement-breakpoint
ALTER TABLE "log_entries" ADD COLUMN "tag" "log_tag" NOT NULL;--> statement-breakpoint
ALTER TABLE "log_entries" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "log_revisions" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_id_tag_key" UNIQUE("id","tag");--> statement-breakpoint
ALTER TABLE "log_revisions" ADD CONSTRAINT "log_revisions_entry_tag_fk" FOREIGN KEY ("log_entry_id","tag") REFERENCES "public"."log_entries"("id","tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_entries_project_created_idx" ON "log_entries" USING btree ("project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "log_entries_project_tag_created_idx" ON "log_entries" USING btree ("project_id","tag","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "log_entries_client_id_key" ON "log_entries" USING btree ("project_id","author_id","client_id");--> statement-breakpoint
ALTER TABLE "log_revisions" ADD CONSTRAINT "log_revisions_links_array_check" CHECK (jsonb_typeof("log_revisions"."links") = 'array');