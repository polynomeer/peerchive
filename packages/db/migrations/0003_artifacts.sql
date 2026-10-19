CREATE TYPE "public"."artifact_kind" AS ENUM('file', 'link', 'repo', 'demo');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'scanning', 'clean', 'quarantined', 'failed');--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"uploader_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"declared_type" text NOT NULL,
	"media_type" text,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"scan_reason" text,
	"scan_engine" text,
	"scan_attempts" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "artifact_versions_artifact_id_version_no_key" UNIQUE("artifact_id","version_no"),
	CONSTRAINT "artifact_versions_artifact_id_sha256_key" UNIQUE("artifact_id","sha256"),
	CONSTRAINT "artifact_versions_version_no_check" CHECK ("artifact_versions"."version_no" >= 1),
	CONSTRAINT "artifact_versions_bytes_check" CHECK ("artifact_versions"."bytes" >= 0),
	CONSTRAINT "artifact_versions_sha256_check" CHECK ("artifact_versions"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"kind" "artifact_kind" DEFAULT 'file' NOT NULL,
	"title" text NOT NULL,
	"usage_terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_revision_evidence" (
	"log_revision_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "log_revision_evidence_pkey" PRIMARY KEY("log_revision_id","artifact_version_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "outbox_events_payload_object_check" CHECK (jsonb_typeof("outbox_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"artifact_id" uuid,
	"file_name" text NOT NULL,
	"declared_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"client_id" uuid,
	"quarantine_key" text NOT NULL,
	"sha256" text,
	"uploaded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"artifact_version_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intents_quarantine_key_unique" UNIQUE("quarantine_key"),
	CONSTRAINT "upload_intents_byte_size_check" CHECK ("upload_intents"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_revision_evidence" ADD CONSTRAINT "log_revision_evidence_log_revision_id_log_revisions_id_fk" FOREIGN KEY ("log_revision_id") REFERENCES "public"."log_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_revision_evidence" ADD CONSTRAINT "log_revision_evidence_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_versions_uploader_id_idx" ON "artifact_versions" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "artifacts_project_created_idx" ON "artifacts" USING btree ("project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "log_revision_evidence_artifact_version_id_idx" ON "log_revision_evidence" USING btree ("artifact_version_id");--> statement-breakpoint
CREATE INDEX "outbox_events_undispatched_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."dispatched_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intents_client_id_key" ON "upload_intents" USING btree ("project_id","user_id","client_id");--> statement-breakpoint
CREATE INDEX "upload_intents_user_id_idx" ON "upload_intents" USING btree ("user_id");