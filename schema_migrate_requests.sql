-- Run this migration against your PostgreSQL database
-- Creates the signing_requests table for Flow 2 (Request Signature)

CREATE TABLE IF NOT EXISTS signing_requests (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_name VARCHAR(255) NOT NULL,
  document_data TEXT        NOT NULL,  -- base64-encoded PDF/image
  document_type VARCHAR(10) NOT NULL DEFAULT 'pdf',  -- 'pdf' | 'image'
  status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'signed'
  recipient_email VARCHAR(255),
  message       TEXT,
  placements    JSONB       NOT NULL DEFAULT '[]', -- [{x, y, w, h, page, pageW, pageH}]
  token         VARCHAR(64) UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at     TIMESTAMPTZ,
  signed_pdf    TEXT        -- base64-encoded signed PDF (set after signing)
);

CREATE INDEX IF NOT EXISTS signing_requests_owner_idx ON signing_requests(owner_id);
CREATE INDEX IF NOT EXISTS signing_requests_token_idx ON signing_requests(token);
