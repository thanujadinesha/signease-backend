-- SignEase database schema
-- ──────────────────────────────────────────────────────────────────
-- Step 1: Create the database (run once as superuser):
--   docker exec -it <postgres-container> psql -U postgres -c "CREATE DATABASE signease_db;"
--
-- Step 2: Apply this schema inside the new database:
--   docker exec -i <postgres-container> psql -U postgres -d signease_db < schema.sql
-- ──────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255)  UNIQUE NOT NULL,
  password_hash   VARCHAR(255)  NOT NULL,
  tier            VARCHAR(50)   NOT NULL DEFAULT 'free',  -- free | pro | unlimited
  signatures_used INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signed_documents (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_name TEXT,
  signed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signed_documents_user_id ON signed_documents(user_id);
