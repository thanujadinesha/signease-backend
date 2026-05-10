-- Multi-signer extension for signing_requests
-- Run this after schema_migrate_requests.sql

ALTER TABLE signing_requests
  ADD COLUMN IF NOT EXISTS signers      JSONB        NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS current_slot INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_slots  INTEGER      NOT NULL DEFAULT 1;

-- Per-signer token table
CREATE TABLE IF NOT EXISTS signing_slots (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID         NOT NULL REFERENCES signing_requests(id) ON DELETE CASCADE,
  slot           INTEGER      NOT NULL,
  email          VARCHAR(255) NOT NULL,
  label          VARCHAR(100) NOT NULL DEFAULT 'Signer',
  token          VARCHAR(64)  UNIQUE NOT NULL,
  signed_at      TIMESTAMPTZ,
  signature_data TEXT         -- base64 PNG data URL of the drawn signature
);

CREATE INDEX IF NOT EXISTS signing_slots_request_idx ON signing_slots(request_id);
CREATE INDEX IF NOT EXISTS signing_slots_token_idx   ON signing_slots(token);
