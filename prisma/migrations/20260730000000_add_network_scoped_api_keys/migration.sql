-- Migration: network-scoped API keys (#977)
--
-- The API key prefix already encodes the environment (mux_live_ / mux_test_).
-- This migration adds an explicit `network` column to ApiKey so the mismatch
-- check can be enforced at the DB level in addition to the application layer,
-- and enables future per-network key scoping in policy enforcement.

ALTER TABLE "ApiKey"
  ADD COLUMN "network" TEXT;

-- Backfill existing keys from their prefix
UPDATE "ApiKey"
  SET "network" = CASE
    WHEN "keyPrefix" LIKE 'mux_live_%' THEN 'MAINNET'
    WHEN "keyPrefix" LIKE 'mux_test_%' THEN 'TESTNET'
    ELSE NULL
  END;

-- Index for network-scoped queries
CREATE INDEX "ApiKey_network_idx" ON "ApiKey" ("network");
