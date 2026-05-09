-- Billing migration — run once on existing signease_db
-- docker exec -i postgres16 psql -U postgres -d signease_db < schema_migrate_billing.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_seats       INTEGER NOT NULL DEFAULT 0;

-- Rename old 'unlimited' tier entries to 'premium' (optional cleanup)
-- UPDATE users SET tier = 'premium' WHERE tier = 'unlimited';
