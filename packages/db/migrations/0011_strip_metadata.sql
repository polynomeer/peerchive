ALTER TABLE "artifact_versions" ADD COLUMN "metadata_stripped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "stripped_sha256" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "stripped_bytes" bigint;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "metadata_findings" jsonb;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_stripped_sha256_check" CHECK ("artifact_versions"."stripped_sha256" is null or "artifact_versions"."stripped_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_stripped_bytes_check" CHECK ("artifact_versions"."stripped_bytes" is null or "artifact_versions"."stripped_bytes" >= 0);