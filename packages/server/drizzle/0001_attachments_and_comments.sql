CREATE TABLE "comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"author_id" uuid NOT NULL,
	"parent_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"asset_id" uuid,
	"url" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_kind" CHECK ("entry_attachments"."kind" in ('image','file','link')),
	CONSTRAINT "attachment_target" CHECK (("entry_attachments"."kind" in ('image','file') and "entry_attachments"."asset_id" is not null and "entry_attachments"."url" is null)
        or ("entry_attachments"."kind" = 'link' and "entry_attachments"."asset_id" is null and "entry_attachments"."url" is not null))
);
--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_asset_id_unique";--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entry_content";--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_asset_id_assets_id_fk";--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "extension" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_attachments" ADD CONSTRAINT "entry_attachments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_attachments" ADD CONSTRAINT "entry_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_entry" ON "comments" USING btree ("entry_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comments_parent" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_attachment_position" ON "entry_attachments" USING btree ("entry_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_attachment_asset" ON "entry_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "entry_attachment_entry" ON "entry_attachments" USING btree ("entry_id","kind","position");--> statement-breakpoint
INSERT INTO "entry_attachments" ("entry_id", "kind", "asset_id", "position")
SELECT "id", 'image', "asset_id", 0 FROM "entries" WHERE "asset_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN "asset_id";--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "asset_kind" CHECK ("assets"."kind" in ('image','file'));
