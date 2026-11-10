ALTER TABLE users ADD COLUMN bio text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN pronouns text NOT NULL DEFAULT 'not specified';
ALTER TABLE users ADD COLUMN location text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN social_links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN show_email boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN show_location boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN show_social_links boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN show_following boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN show_followers boolean NOT NULL DEFAULT true;
ALTER TABLE entries ADD COLUMN visibility text NOT NULL DEFAULT 'public';
ALTER TABLE entries ADD CONSTRAINT valid_visibility CHECK (visibility IN ('public','registered','followers','following','private'));
CREATE TABLE follows (
 follower_id uuid NOT NULL CONSTRAINT follows_follower_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
 followed_id uuid NOT NULL CONSTRAINT follows_followed_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT follows_follower_id_followed_id_pk PRIMARY KEY (follower_id, followed_id),
 CONSTRAINT follows_not_self CHECK (follower_id <> followed_id)
);
CREATE INDEX follows_followed ON follows(followed_id);
CREATE TABLE site_settings (
 id integer PRIMARY KEY DEFAULT 1 CONSTRAINT site_singleton CHECK (id = 1),
 title text NOT NULL DEFAULT 'hzlt!Collections',
 description text NOT NULL DEFAULT '登录后继续发布和喜欢内容。',
 logo_url text,
 registration_open boolean NOT NULL DEFAULT true
);
INSERT INTO site_settings (id) VALUES (1);
