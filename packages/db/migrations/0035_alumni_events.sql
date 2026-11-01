CREATE TYPE "public"."room_event_recurrence" AS ENUM('none', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."room_event_status" AS ENUM('scheduled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rsvp_response" AS ENUM('going', 'not_going', 'maybe');--> statement-breakpoint
CREATE TABLE "notice_reads" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_reads_pkey" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_album_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"caption" text,
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
	CONSTRAINT "room_album_photos_object_key_check" CHECK ("room_album_photos"."object_key" ~ '^quarantine/[0-9a-f-]{36}$'),
	CONSTRAINT "room_album_photos_extension_check" CHECK ("room_album_photos"."file_extension" in ('png', 'jpg', 'jpeg', 'webp')),
	CONSTRAINT "room_album_photos_byte_size_check" CHECK ("room_album_photos"."byte_size" between 1 and 10485760),
	CONSTRAINT "room_album_photos_sha256_check" CHECK ("room_album_photos"."sha256" is null or "room_album_photos"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "room_album_photos_caption_check" CHECK ("room_album_photos"."caption" is null or char_length("room_album_photos"."caption") between 1 and 100),
	CONSTRAINT "room_album_photos_clean_check" CHECK ("room_album_photos"."scan_status"::text <> 'clean' or ("room_album_photos"."metadata_stripped" and "room_album_photos"."media_type" is not null))
);
--> statement-breakpoint
CREATE TABLE "room_event_rsvps" (
	"event_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"user_id" uuid NOT NULL,
	"response" "rsvp_response" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_event_rsvps_pkey" PRIMARY KEY("event_id","occurrence_date","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location_text" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"recurrence" "room_event_recurrence" DEFAULT 'none' NOT NULL,
	"repeat_until" date,
	"status" "room_event_status" DEFAULT 'scheduled' NOT NULL,
	"created_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_events_title_check" CHECK (char_length("room_events"."title") between 1 and 80),
	CONSTRAINT "room_events_description_check" CHECK ("room_events"."description" is null or char_length("room_events"."description") between 1 and 1000),
	CONSTRAINT "room_events_location_check" CHECK ("room_events"."location_text" is null or char_length("room_events"."location_text") between 1 and 100),
	CONSTRAINT "room_events_ends_check" CHECK ("room_events"."ends_at" is null or ("room_events"."ends_at" > "room_events"."starts_at" and "room_events"."ends_at" <= "room_events"."starts_at" + interval '7 days')),
	CONSTRAINT "room_events_repeat_check" CHECK (("room_events"."recurrence"::text = 'none') = ("room_events"."repeat_until" is null)),
	CONSTRAINT "room_events_cancelled_check" CHECK (("room_events"."status"::text = 'cancelled') = ("room_events"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "room_poll_votes" (
	"poll_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_poll_votes_pkey" PRIMARY KEY("poll_id","user_id"),
	CONSTRAINT "room_poll_votes_option_check" CHECK ("room_poll_votes"."option_index" between 0 and 9)
);
--> statement-breakpoint
CREATE TABLE "room_polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"question" text NOT NULL,
	"options" text[] NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_polls_question_check" CHECK (char_length("room_polls"."question") between 1 and 120),
	CONSTRAINT "room_polls_options_check" CHECK (cardinality("room_polls"."options") between 2 and 10)
);
--> statement-breakpoint
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_album_photos" ADD CONSTRAINT "room_album_photos_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_album_photos" ADD CONSTRAINT "room_album_photos_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_event_rsvps" ADD CONSTRAINT "room_event_rsvps_event_id_room_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."room_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_event_rsvps" ADD CONSTRAINT "room_event_rsvps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_poll_votes" ADD CONSTRAINT "room_poll_votes_poll_id_room_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."room_polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_poll_votes" ADD CONSTRAINT "room_poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_polls" ADD CONSTRAINT "room_polls_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_polls" ADD CONSTRAINT "room_polls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_reads_user_space_idx" ON "notice_reads" USING btree ("user_id","space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_album_photos_object_key_key" ON "room_album_photos" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "room_album_photos_space_created_idx" ON "room_album_photos" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "room_album_photos_uploader_idx" ON "room_album_photos" USING btree ("uploader_id","space_id");--> statement-breakpoint
CREATE INDEX "room_event_rsvps_user_id_idx" ON "room_event_rsvps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "room_events_space_starts_idx" ON "room_events" USING btree ("space_id","starts_at");--> statement-breakpoint
CREATE INDEX "room_events_created_by_idx" ON "room_events" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "room_poll_votes_user_id_idx" ON "room_poll_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "room_polls_space_created_idx" ON "room_polls" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "room_polls_created_by_idx" ON "room_polls" USING btree ("created_by");