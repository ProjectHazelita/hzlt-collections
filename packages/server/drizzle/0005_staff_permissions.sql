ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN is_moderator boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN banned boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN ban_reason text;
ALTER TABLE users ADD COLUMN hidden_profile_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE staff_grants (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admin jsonb NOT NULL DEFAULT '["site.brand","site.registration","users.manage","users.ban","users.profile","audit.read"]'::jsonb,
  moderator jsonb NOT NULL DEFAULT '["content.moderate","content.delete","audit.read"]'::jsonb
);
INSERT INTO staff_grants (id) VALUES (1);
CREATE TABLE audit_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
