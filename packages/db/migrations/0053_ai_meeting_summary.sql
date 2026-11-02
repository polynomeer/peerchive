ALTER TYPE "public"."analytics_event_name" ADD VALUE 'ai_meeting_draft_proposed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'ai_meeting_draft_resolved';--> statement-breakpoint
CREATE TABLE "ai_meeting_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_meeting_channels_binding_key" UNIQUE("binding_id")
);
--> statement-breakpoint
CREATE TABLE "ai_meeting_consents" (
	"meeting_channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_meeting_consents_pkey" PRIMARY KEY("meeting_channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_meeting_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_channel_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"interaction_id" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_count" integer DEFAULT 0 NOT NULL,
	"attachments_omitted" integer DEFAULT 0 NOT NULL,
	"message_count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_meeting_drafts_interaction_key" UNIQUE("interaction_id"),
	CONSTRAINT "ai_meeting_drafts_summary_check" CHECK (char_length("ai_meeting_drafts"."summary") <= 2000),
	CONSTRAINT "ai_meeting_drafts_arrays_check" CHECK (jsonb_typeof("ai_meeting_drafts"."decisions") = 'array' and jsonb_typeof("ai_meeting_drafts"."follow_ups") = 'array' and jsonb_typeof("ai_meeting_drafts"."open_questions") = 'array' and jsonb_typeof("ai_meeting_drafts"."attendees") = 'array'),
	CONSTRAINT "ai_meeting_drafts_counts_check" CHECK ("ai_meeting_drafts"."message_count" between 1 and 200 and "ai_meeting_drafts"."external_count" >= 0 and "ai_meeting_drafts"."attachments_omitted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_meeting_channels" ADD CONSTRAINT "ai_meeting_channels_binding_id_discord_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."discord_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_channels" ADD CONSTRAINT "ai_meeting_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_channels" ADD CONSTRAINT "ai_meeting_channels_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_consents" ADD CONSTRAINT "ai_meeting_consents_meeting_channel_id_ai_meeting_channels_id_fk" FOREIGN KEY ("meeting_channel_id") REFERENCES "public"."ai_meeting_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_consents" ADD CONSTRAINT "ai_meeting_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_drafts" ADD CONSTRAINT "ai_meeting_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_drafts" ADD CONSTRAINT "ai_meeting_drafts_meeting_channel_id_ai_meeting_channels_id_fk" FOREIGN KEY ("meeting_channel_id") REFERENCES "public"."ai_meeting_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_meeting_drafts" ADD CONSTRAINT "ai_meeting_drafts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_meeting_channels_project_idx" ON "ai_meeting_channels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_meeting_consents_user_idx" ON "ai_meeting_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_meeting_drafts_project_idx" ON "ai_meeting_drafts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_meeting_drafts_channel_idx" ON "ai_meeting_drafts" USING btree ("meeting_channel_id");--> statement-breakpoint
CREATE INDEX "ai_meeting_drafts_requested_by_idx" ON "ai_meeting_drafts" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "ai_meeting_drafts_expires_at_idx" ON "ai_meeting_drafts" USING btree ("expires_at");