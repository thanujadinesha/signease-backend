-- Migration: add expiry and reminder columns to signing_requests
-- Run: psql $DATABASE_URL -f migrations/add_request_expiry.sql

ALTER TABLE signing_requests
  ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_interval INT,
  ADD COLUMN IF NOT EXISTS reminder_sent_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_signing_requests_expires_at
  ON signing_requests (expires_at)
  WHERE status = 'pending';
