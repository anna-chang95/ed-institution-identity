-- Migration: 003_gist_exclusion_constraint
-- Description: Adds the GiST exclusion constraint that Prisma cannot express.
-- Database: PostgreSQL
--
-- WHY THIS EXISTS:
-- Prisma's schema language does not support PostgreSQL exclusion constraints.
-- If the database was created via `npx prisma migrate dev`, the institution_version
-- table will be missing the constraint that prevents overlapping date ranges.
-- This migration adds it as a supplementary step.
--
-- If the database was created via 001_initial.sql (which includes the constraint
-- in the CREATE TABLE), this migration is a no-op.
--
-- WHEN TO RUN:
-- After `npx prisma migrate dev` — apply this directly against your database:
--   psql $DATABASE_URL -f migrations/003_gist_exclusion_constraint.sql

-- Required for daterange exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prevent overlapping date ranges for the same institution.
-- Without this, two institution_version rows could both claim to be valid
-- on the same date, breaking the bitemporal "school at date X" query.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'no_overlapping_versions'
  ) THEN
    ALTER TABLE institution_version
      ADD CONSTRAINT no_overlapping_versions EXCLUDE USING gist (
        institution_id WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      );
  END IF;
END $$;
