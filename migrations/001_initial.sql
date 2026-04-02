-- Migration: 001_initial
-- Description: Initial schema for high school institution identity system
-- Database: PostgreSQL
--
-- This is the raw SQL equivalent of prisma/schema.prisma.
-- If using Prisma, run: npx prisma migrate dev
-- If applying manually, run this file directly against your PostgreSQL instance.
--
-- Table creation order matters due to foreign key constraints:
--   1. institution (no dependencies)
--   2. institution_version (depends on institution)
--   3. institution_lifecycle_event (depends on institution x2)
--   4. partner_crosswalk (depends on institution)
--   5. school_year_report (depends on institution)

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE institution_type AS ENUM (
  'HIGH_SCHOOL',
  'COMMUNITY_COLLEGE',
  'CHARTER',
  'ALTERNATIVE'
);

CREATE TYPE institution_status AS ENUM (
  'ACTIVE',
  'CLOSED',
  'MERGED_OUT'
);

CREATE TYPE lifecycle_event_type AS ENUM (
  'RENAME',
  'MERGE_IN',
  'MERGE_OUT',
  'SPLIT',
  'CLOSURE',
  'REOPEN'
);

CREATE TYPE resolution_method AS ENUM (
  'EXACT',
  'PHONETIC',
  'FUZZY',
  'EMBEDDING',
  'MANUAL'
);

-- ---------------------------------------------------------------------------
-- INSTITUTION
-- The canonical identity record. One row per school, ever.
-- institution_id never changes — not for renames, merges, or closures.
-- ---------------------------------------------------------------------------

CREATE TABLE institution (
  institution_id  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_type institution_type   NOT NULL,
  nces_id         VARCHAR(20)         UNIQUE,         -- National Center for Ed Stats ID
  status          institution_status  NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  created_by      VARCHAR(255)        NOT NULL        -- source system or user
);

COMMENT ON TABLE institution IS
  'Canonical identity record. One row per school. ID never changes.';

COMMENT ON COLUMN institution.nces_id IS
  'National Center for Education Statistics ID. Nullable — not all schools have one.';

-- ---------------------------------------------------------------------------
-- INSTITUTION VERSION (bitemporal)
-- Every name/address change creates a new row. Old rows are never deleted.
-- valid_to = NULL means currently active.
--
-- Query pattern for "school at date X":
--   WHERE institution_id = $1
--     AND valid_from <= $2
--     AND (valid_to IS NULL OR valid_to > $2)
-- ---------------------------------------------------------------------------

CREATE TABLE institution_version (
  version_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id    UUID          NOT NULL REFERENCES institution(institution_id),
  valid_from        DATE          NOT NULL,   -- inclusive: when this version became official
  valid_to          DATE,                     -- exclusive: NULL = currently valid
  name              TEXT          NOT NULL,   -- official name at this time
  name_normalized   TEXT          NOT NULL,   -- lowercased, abbreviations expanded, for matching
  address_line1     TEXT,
  city              TEXT,
  state             CHAR(2),                  -- ISO state code e.g. 'MI', 'CA'
  zip               VARCHAR(10),
  county_fips       CHAR(5),                  -- for geographic disambiguation
  source            VARCHAR(100),             -- NCES, partner, manual, etc.

  -- A school should only have one active version at a time
  CONSTRAINT no_overlapping_versions EXCLUDE USING gist (
    institution_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

COMMENT ON TABLE institution_version IS
  'Bitemporal attribute snapshots. Query with valid_from/valid_to range to get state at any point in time.';

COMMENT ON COLUMN institution_version.valid_to IS
  'Exclusive upper bound. NULL means this version is currently active.';

COMMENT ON COLUMN institution_version.name_normalized IS
  'Pre-computed normalized form: lowercase, abbreviations expanded, punctuation stripped. Used for matching.';

-- Indexes for common query patterns
CREATE INDEX idx_version_institution_dates
  ON institution_version (institution_id, valid_from, valid_to);

CREATE INDEX idx_version_state_name
  ON institution_version (state, name_normalized);

CREATE INDEX idx_version_name_normalized
  ON institution_version (name_normalized);

-- ---------------------------------------------------------------------------
-- INSTITUTION LIFECYCLE EVENT
-- Append-only log of structural changes: renames, merges, closures.
-- Never deleted. Full audit trail.
-- ---------------------------------------------------------------------------

CREATE TABLE institution_lifecycle_event (
  event_id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id          UUID                  NOT NULL REFERENCES institution(institution_id),
  event_type              lifecycle_event_type  NOT NULL,
  event_date              DATE                  NOT NULL,   -- when it happened in the real world
  related_institution_id  UUID                  REFERENCES institution(institution_id), -- e.g. surviving entity in a merge
  notes                   TEXT,                             -- free-form detail for reviewers
  source_document         TEXT,                             -- URL or reference to evidence
  created_at              TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  created_by              VARCHAR(255)          NOT NULL
);

COMMENT ON TABLE institution_lifecycle_event IS
  'Append-only log of structural changes. Never deleted or updated.';

COMMENT ON COLUMN institution_lifecycle_event.related_institution_id IS
  'The other party in a merge or split event. e.g. for MERGE_OUT, this is the surviving institution.';

CREATE INDEX idx_lifecycle_institution_date
  ON institution_lifecycle_event (institution_id, event_date);

-- ---------------------------------------------------------------------------
-- PARTNER CROSSWALK
-- Maps a partner identifier or raw name to our canonical institution_id.
-- One row per unique (partner_id, partner_key) pair.
-- Acts as a cache with confidence — partner noise never contaminates
-- canonical institution data.
-- ---------------------------------------------------------------------------

CREATE TABLE partner_crosswalk (
  crosswalk_id      UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        VARCHAR(100)      NOT NULL,   -- e.g. 'NAVIANCE', 'COMMON_APP'
  partner_key       TEXT              NOT NULL,   -- raw value as partner sent it
  institution_id    UUID              NOT NULL REFERENCES institution(institution_id),
  confidence        NUMERIC(4,3)      NOT NULL    -- 0.000 – 1.000
                    CHECK (confidence >= 0 AND confidence <= 1),
  resolution_method resolution_method NOT NULL,
  is_verified       BOOLEAN           NOT NULL DEFAULT FALSE,
  reviewed_by       VARCHAR(255),                -- user ID if manually reviewed
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  -- A partner key should only map to one institution
  CONSTRAINT unique_partner_key UNIQUE (partner_id, partner_key)
);

COMMENT ON TABLE partner_crosswalk IS
  'Maps partner identifiers/names to canonical institution_id. Confidence score enables downstream threshold filtering.';

COMMENT ON COLUMN partner_crosswalk.partner_key IS
  'The raw value exactly as the partner sent it — name string, numeric code, or partner-internal ID.';

COMMENT ON COLUMN partner_crosswalk.is_verified IS
  'TRUE only after human confirmation or a high-confidence exact match. Unverified mappings should not be used for fraud detection.';

CREATE INDEX idx_crosswalk_institution
  ON partner_crosswalk (institution_id);

CREATE INDEX idx_crosswalk_lookup
  ON partner_crosswalk (partner_id, partner_key, is_verified);

-- ---------------------------------------------------------------------------
-- SCHOOL YEAR REPORT
-- Annual statistics per institution: AP offerings, enrollment, demographics.
-- Used to contextualize a transcript (e.g. how many AP courses did this
-- school offer in the year this transcript was issued?).
-- ---------------------------------------------------------------------------

CREATE TABLE school_year_report (
  report_id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id          UUID          NOT NULL REFERENCES institution(institution_id),
  school_year             SMALLINT      NOT NULL,   -- e.g. 2009 = the 2008–2009 academic year
  enrollment              INT,
  ap_course_count         SMALLINT,
  free_reduced_lunch_pct  NUMERIC(5,2),
  graduation_rate         NUMERIC(5,2),
  data_source             VARCHAR(100),             -- NCES, state data, partner, etc.
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_institution_year UNIQUE (institution_id, school_year)
);

COMMENT ON TABLE school_year_report IS
  'Annual statistics per institution. Used to interpret transcripts in context.';

COMMENT ON COLUMN school_year_report.school_year IS
  'The ending year of the academic year. 2009 = 2008–2009 school year.';

CREATE INDEX idx_report_institution_year
  ON school_year_report (institution_id, school_year);

-- ---------------------------------------------------------------------------
-- MATERIALIZED VIEW: institution_at
-- Pre-joins bitemporal columns for warehouse/analytics consumers.
-- Analysts query this — never the raw version or lifecycle tables directly.
-- Refresh nightly: REFRESH MATERIALIZED VIEW CONCURRENTLY institution_at;
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW institution_at AS
SELECT
  i.institution_id,
  i.institution_type,
  i.nces_id,
  i.status                      AS current_status,
  v.version_id,
  v.valid_from,
  v.valid_to,
  v.name                        AS name_at_period,
  v.name_normalized,
  v.city,
  v.state,
  v.zip,
  r.school_year,
  r.enrollment,
  r.ap_course_count,
  r.free_reduced_lunch_pct,
  r.graduation_rate
FROM institution i
JOIN institution_version v
  ON v.institution_id = i.institution_id
LEFT JOIN school_year_report r
  ON  r.institution_id = i.institution_id
  AND r.school_year BETWEEN
      EXTRACT(YEAR FROM v.valid_from)::INT
      AND COALESCE(EXTRACT(YEAR FROM v.valid_to)::INT, 9999);

COMMENT ON MATERIALIZED VIEW institution_at IS
  'Flattened view for analytics/warehouse. Refresh nightly. Analysts use this — not the raw tables.';

CREATE INDEX idx_institution_at_id_dates
  ON institution_at (institution_id, valid_from, valid_to);

CREATE INDEX idx_institution_at_state_name
  ON institution_at (state, name_normalized);
