-- A-04 공감 라운지 미디어(ADR 0041): community_post_media. 공식 학교 페이지 자유 게시판 글의 이미지(영상은 미룸). 격리 키·검사·메타데이터 제거는 앨범 사진(0035)과 같습니다.
-- 새 표는 커뮤니티 구역이라 social DB 역할(peerchive_social)에 권한을 주지 않습니다(peerchive_apply_social_grants는 표를 이름으로만 허용하므로 다시 정의하지 않음).
CREATE TABLE "community_post_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"declared_type" text NOT NULL,
	"file_extension" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text,
	"uploaded_at" timestamp with time zone,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"scan_reason" text,
	"scan_engine" text,
	"scan_attempts" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"media_type" text,
	"metadata_stripped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_post_media_object_key_check" CHECK ("community_post_media"."object_key" ~ '^quarantine/[0-9a-f-]{36}$'),
	CONSTRAINT "community_post_media_extension_check" CHECK ("community_post_media"."file_extension" in ('png', 'jpg', 'jpeg', 'webp')),
	CONSTRAINT "community_post_media_byte_size_check" CHECK ("community_post_media"."byte_size" between 1 and 10485760),
	CONSTRAINT "community_post_media_sha256_check" CHECK ("community_post_media"."sha256" is null or "community_post_media"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "community_post_media_clean_check" CHECK ("community_post_media"."scan_status"::text <> 'clean' or ("community_post_media"."metadata_stripped" and "community_post_media"."media_type" is not null))
);
--> statement-breakpoint
ALTER TABLE "community_post_media" ADD CONSTRAINT "community_post_media_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_post_media" ADD CONSTRAINT "community_post_media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_post_media_object_key_key" ON "community_post_media" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "community_post_media_post_created_idx" ON "community_post_media" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "community_post_media_uploader_idx" ON "community_post_media" USING btree ("uploader_id");