ALTER TABLE "site_settings" ADD COLUMN "logo_asset_id" uuid;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_logo_asset_id_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;
