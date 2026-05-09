-- Admin migration — run once on existing signease_db
-- docker exec -i postgres16 psql -U postgres -d signease_db < schema_migrate_admin.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- To promote a user to admin, run:
-- UPDATE users SET is_admin = TRUE WHERE email = 'your@email.com';
