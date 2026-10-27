CREATE TYPE "public"."persona_account_privacy" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."persona_kind" AS ENUM('real', 'display');--> statement-breakpoint
CREATE TYPE "public"."persona_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TABLE "identity_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"real_persona_id" uuid NOT NULL,
	"display_persona_id" uuid NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_real_persona_key" UNIQUE("real_persona_id"),
	CONSTRAINT "identity_links_display_persona_key" UNIQUE("display_persona_id"),
	CONSTRAINT "identity_links_distinct_check" CHECK ("identity_links"."real_persona_id" <> "identity_links"."display_persona_id")
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "persona_kind" NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"account_privacy" "persona_account_privacy" DEFAULT 'public' NOT NULL,
	"show_follower_count" boolean DEFAULT true NOT NULL,
	"status" "persona_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_user_kind_key" UNIQUE("user_id","kind"),
	CONSTRAINT "personas_handle_key" UNIQUE("handle"),
	CONSTRAINT "personas_id_kind_handle_key" UNIQUE("id","kind","handle"),
	CONSTRAINT "personas_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "personas_handle_format_check" CHECK ("personas"."handle" ~ '^[a-z0-9-]{3,30}$'),
	CONSTRAINT "personas_display_name_check" CHECK (("personas"."kind" = 'real' and "personas"."display_name" is null) or ("personas"."kind" = 'display' and char_length("personas"."display_name") between 1 and 50))
);
--> statement-breakpoint
-- S-01(ADR 0028) 기존 행 채우기. 프로필마다 같은 handle의 real 페르소나를 만듭니다(이름은 users.display_name을 그대로 쓰므로 공개 출력이 바뀌지 않음).
INSERT INTO "personas" ("user_id", "kind", "handle", "created_at", "updated_at")
SELECT "user_id", 'real', "handle", "created_at", "updated_at" FROM "profiles";--> statement-breakpoint
-- 프로필 없이 포트폴리오 판만 있는 사용자(정상 흐름에는 없음): 공개되지 않는 real 페르소나(프로필 행 없음, 자리표시 handle)를 만들어 판을 붙입니다.
-- 그 사람이 나중에 프로필을 만들면 이 페르소나의 handle을 고른 값으로 바꿉니다(identity/profiles.ts upsertProfile).
INSERT INTO "personas" ("user_id", "kind", "handle")
SELECT DISTINCT e."user_id", 'real'::"persona_kind", 'u-' || substr(md5(e."user_id"::text), 1, 12)
FROM "portfolio_editions" e
WHERE NOT EXISTS (SELECT 1 FROM "personas" p WHERE p."user_id" = e."user_id" AND p."kind" = 'real');--> statement-breakpoint
ALTER TABLE "portfolio_editions" DROP CONSTRAINT "portfolio_editions_user_version_key";--> statement-breakpoint
DROP INDEX "portfolio_editions_current_key";--> statement-breakpoint
ALTER TABLE "portfolio_editions" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
UPDATE "portfolio_editions" e SET "persona_id" = p."id" FROM "personas" p WHERE p."user_id" = e."user_id" AND p."kind" = 'real';--> statement-breakpoint
ALTER TABLE "portfolio_editions" ALTER COLUMN "persona_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_pkey";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "persona_kind" "persona_kind";--> statement-breakpoint
UPDATE "profiles" f SET "persona_id" = p."id", "persona_kind" = 'real' FROM "personas" p WHERE p."user_id" = f."user_id" AND p."kind" = 'real';--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "persona_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "persona_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("persona_id");--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_real_persona_fk" FOREIGN KEY ("real_persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_display_persona_fk" FOREIGN KEY ("display_persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_editions" ADD CONSTRAINT "portfolio_editions_persona_user_fk" FOREIGN KEY ("persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_persona_handle_fk" FOREIGN KEY ("persona_id","persona_kind","handle") REFERENCES "public"."personas"("id","kind","handle") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_persona_user_fk" FOREIGN KEY ("persona_id","user_id") REFERENCES "public"."personas"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_editions_user_id_idx" ON "portfolio_editions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_editions_current_key" ON "portfolio_editions" USING btree ("persona_id") WHERE "portfolio_editions"."status" = 'current';--> statement-breakpoint
ALTER TABLE "portfolio_editions" ADD CONSTRAINT "portfolio_editions_persona_version_key" UNIQUE("persona_id","version");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_key" UNIQUE("user_id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_kind_check" CHECK (("profiles"."persona_kind" = 'real') = ("profiles"."user_id" is not null));