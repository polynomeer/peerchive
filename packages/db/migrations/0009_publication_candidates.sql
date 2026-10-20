CREATE TYPE "public"."candidate_status" AS ENUM('awaiting_consent', 'ready', 'superseded', 'published', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('pending', 'granted', 'declined', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."publication_level" AS ENUM('summary', 'full');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'embargoed', 'awaiting_consent', 'ready', 'published', 'withdrawn', 'restricted');--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "consent_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"note" text,
	"carried_from_candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_candidate_subject_key" UNIQUE("candidate_id","subject_user_id"),
	CONSTRAINT "consents_manifest_hash_check" CHECK ("consents"."manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consents_note_check" CHECK ("consents"."note" is null or char_length("consents"."note") between 1 and 300),
	CONSTRAINT "consents_decided_check" CHECK (("consents"."status" = 'pending') = ("consents"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "publication_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"level" "publication_level" NOT NULL,
	"status" "candidate_status" DEFAULT 'awaiting_consent' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"selection" jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_digests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"derived_from_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "publication_candidates_publication_version_key" UNIQUE("publication_id","version"),
	CONSTRAINT "publication_candidates_version_check" CHECK ("publication_candidates"."version" >= 1),
	CONSTRAINT "publication_candidates_manifest_hash_check" CHECK ("publication_candidates"."manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "publication_candidates_snapshot_object_check" CHECK (jsonb_typeof("publication_candidates"."snapshot") = 'object'),
	CONSTRAINT "publication_candidates_manifest_object_check" CHECK (jsonb_typeof("publication_candidates"."manifest") = 'object'),
	CONSTRAINT "publication_candidates_superseded_check" CHECK (("publication_candidates"."status" = 'superseded') = ("publication_candidates"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"level" "publication_level" NOT NULL,
	"status" "publication_status" DEFAULT 'draft' NOT NULL,
	"current_release_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "publications_slug_unique" UNIQUE("slug"),
	CONSTRAINT "publications_slug_format_check" CHECK ("publications"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("publications"."slug") between 3 and 60)
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_candidate_id_publication_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_carried_from_candidate_id_publication_candidates_id_fk" FOREIGN KEY ("carried_from_candidate_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_derived_from_id_publication_candidates_id_fk" FOREIGN KEY ("derived_from_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_current_release_id_fk" FOREIGN KEY ("current_release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_subject_status_idx" ON "consents" USING btree ("subject_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_candidates_open_key" ON "publication_candidates" USING btree ("publication_id") WHERE "publication_candidates"."status" in ('awaiting_consent', 'ready');--> statement-breakpoint
CREATE INDEX "publication_candidates_project_id_idx" ON "publication_candidates" USING btree ("project_id");