ALTER TABLE "users" ADD COLUMN "display_name" text;
--> statement-breakpoint
UPDATE "users" SET "display_name" = "username";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "display_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_asset_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_avatar_asset_unique" ON "users" USING btree ("avatar_asset_id");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "valid_display_name" CHECK (char_length("users"."display_name") between 1 and 32);
