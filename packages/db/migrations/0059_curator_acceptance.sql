ALTER TABLE "course_curators" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "course_curators" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "course_curators" ADD CONSTRAINT "course_curators_declined_check" CHECK ("course_curators"."declined_at" is null or ("course_curators"."revoked_at" is not null and "course_curators"."accepted_at" is null));--> statement-breakpoint
-- ADR 0060 D-08: 이미 지정된 큐레이터는 수락한 것으로 옮깁니다(대기 상태는 이 뒤의 새 지정부터).
UPDATE "course_curators" SET "accepted_at" = "granted_at";
