CREATE TYPE "public"."github_item_kind" AS ENUM('commit', 'pull_request');--> statement-breakpoint
CREATE TYPE "public"."github_pr_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."github_state_purpose" AS ENUM('identity', 'install', 'install_verify', 'select');--> statement-breakpoint
CREATE TABLE "github_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "github_item_kind" NOT NULL,
	"sha" text,
	"number" integer,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"author_github_id" bigint NOT NULL,
	"pr_state" "github_pr_state",
	"occurred_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_items_link_sha_key" UNIQUE("link_id","sha"),
	CONSTRAINT "github_items_link_number_key" UNIQUE("link_id","number"),
	CONSTRAINT "github_items_kind_check" CHECK (("github_items"."kind"::text = 'commit' and "github_items"."sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' and "github_items"."number" is null and "github_items"."pr_state" is null)
        or ("github_items"."kind"::text = 'pull_request' and "github_items"."sha" is null and "github_items"."number" > 0 and "github_items"."pr_state" is not null)),
	CONSTRAINT "github_items_title_check" CHECK (char_length("github_items"."title") between 1 and 200),
	CONSTRAINT "github_items_url_check" CHECK ("github_items"."url" ~ '^https://github[.]com/' and char_length("github_items"."url") <= 500)
);
--> statement-breakpoint
CREATE TABLE "github_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "github_state_purpose" NOT NULL,
	"state_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"installation_id" bigint,
	"repos" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_oauth_states_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "github_oauth_states_project_check" CHECK (("github_oauth_states"."purpose"::text = 'identity') = ("github_oauth_states"."project_id" is null)),
	CONSTRAINT "github_oauth_states_installation_check" CHECK (("github_oauth_states"."purpose"::text in ('install_verify', 'select')) = ("github_oauth_states"."installation_id" is not null)),
	CONSTRAINT "github_oauth_states_repos_check" CHECK (("github_oauth_states"."purpose"::text = 'select') = ("github_oauth_states"."repos" is not null))
);
--> statement-breakpoint
CREATE TABLE "github_repo_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"html_url" text NOT NULL,
	"is_private" boolean NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlink_reason" text,
	CONSTRAINT "github_repo_links_html_url_check" CHECK ("github_repo_links"."html_url" ~ '^https://github[.]com/' and char_length("github_repo_links"."html_url") <= 300),
	CONSTRAINT "github_repo_links_full_name_check" CHECK (char_length("github_repo_links"."full_name") between 3 and 200),
	CONSTRAINT "github_repo_links_unlink_check" CHECK (("github_repo_links"."unlinked_at" is null and "github_repo_links"."unlink_reason" is null)
        or ("github_repo_links"."unlinked_at" is not null and "github_repo_links"."unlink_reason" in ('owner', 'uninstalled', 'repo_removed', 'project_purged')))
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_evidence" DROP CONSTRAINT "claim_evidence_kind_check";--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD COLUMN "github_item_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD COLUMN "github_url" text;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD COLUMN "github_title" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "external_login" text;--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_link_id_github_repo_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."github_repo_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_items_project_author_idx" ON "github_items" USING btree ("project_id","author_github_id","occurred_at");--> statement-breakpoint
CREATE INDEX "github_items_author_idx" ON "github_items" USING btree ("author_github_id");--> statement-breakpoint
CREATE INDEX "github_oauth_states_user_id_idx" ON "github_oauth_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "github_oauth_states_project_id_idx" ON "github_oauth_states" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_links_project_active_key" ON "github_repo_links" USING btree ("project_id") WHERE "github_repo_links"."unlinked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_links_repo_active_key" ON "github_repo_links" USING btree ("repo_id") WHERE "github_repo_links"."unlinked_at" is null;--> statement-breakpoint
CREATE INDEX "github_repo_links_installation_idx" ON "github_repo_links" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_received_at_idx" ON "github_webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_github_item_id_github_items_id_fk" FOREIGN KEY ("github_item_id") REFERENCES "public"."github_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_evidence_github_item_id_idx" ON "claim_evidence" USING btree ("github_item_id");--> statement-breakpoint
CREATE INDEX "integrations_github_login_idx" ON "integrations" USING btree (lower("external_login")) WHERE "integrations"."external_login" is not null;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_github_url_key" UNIQUE("claim_revision_id","github_url");--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_github_check" CHECK (("claim_evidence"."github_url" is null and "claim_evidence"."github_title" is null and "claim_evidence"."github_item_id" is null)
        or ("claim_evidence"."github_url" ~ '^https://github[.]com/' and char_length("claim_evidence"."github_url") <= 500 and "claim_evidence"."github_title" is not null and char_length("claim_evidence"."github_title") between 1 and 200));--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_kind_check" CHECK (("claim_evidence"."log_entry_id" is not null and "claim_evidence"."log_revision_id" is not null and "claim_evidence"."artifact_version_id" is null and "claim_evidence"."github_url" is null)
        or ("claim_evidence"."log_entry_id" is null and "claim_evidence"."log_revision_id" is null and "claim_evidence"."artifact_version_id" is not null and "claim_evidence"."github_url" is null)
        or ("claim_evidence"."log_entry_id" is null and "claim_evidence"."log_revision_id" is null and "claim_evidence"."artifact_version_id" is null and "claim_evidence"."github_url" is not null));--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_external_login_check" CHECK ("integrations"."external_login" is null or ("integrations"."provider"::text = 'github' and char_length("integrations"."external_login") between 1 and 39));