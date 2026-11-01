CREATE TABLE "portfolio_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_share_links_token_hash_check" CHECK ("portfolio_share_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "portfolio_share_links_label_check" CHECK ("portfolio_share_links"."label" is null or char_length("portfolio_share_links"."label") between 1 and 60),
	CONSTRAINT "portfolio_share_links_view_count_check" CHECK ("portfolio_share_links"."view_count" >= 0),
	CONSTRAINT "portfolio_share_links_expiry_check" CHECK ("portfolio_share_links"."expires_at" > "portfolio_share_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "portfolio_share_links" ADD CONSTRAINT "portfolio_share_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_share_links" ADD CONSTRAINT "portfolio_share_links_edition_id_portfolio_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."portfolio_editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_share_links_token_hash_key" ON "portfolio_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portfolio_share_links_user_id_idx" ON "portfolio_share_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "portfolio_share_links_edition_id_idx" ON "portfolio_share_links" USING btree ("edition_id");