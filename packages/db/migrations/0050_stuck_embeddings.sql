CREATE TABLE "stuck_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" real[] NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stuck_embeddings_dims_check" CHECK ("stuck_embeddings"."dims" between 1 and 4096 and cardinality("stuck_embeddings"."embedding") = "stuck_embeddings"."dims"),
	CONSTRAINT "stuck_embeddings_hash_check" CHECK (char_length("stuck_embeddings"."content_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "stuck_embeddings" ADD CONSTRAINT "stuck_embeddings_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stuck_embeddings" ADD CONSTRAINT "stuck_embeddings_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stuck_embeddings_item_key" ON "stuck_embeddings" USING btree ("publication_id","item_key");--> statement-breakpoint
CREATE INDEX "stuck_embeddings_release_idx" ON "stuck_embeddings" USING btree ("release_id");