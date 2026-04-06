-- Migration: 002_seed_example
-- Description: Example data illustrating the Lincoln High School lifecycle
-- Purpose: Demonstrates bitemporal versioning, lifecycle events, crosswalks,
--          and school-year reports using the same scenario from the diagrams and tests.
--
-- This is NOT production seed data — it is a concrete example for the case study.
-- Run after 001_initial.sql.

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for referential clarity
-- ---------------------------------------------------------------------------

-- Lincoln High School (the primary institution in all examples)
-- institution_id: 11111111-1111-1111-1111-111111111111

-- Metro Career High (the surviving institution in the 2018 merge)
-- institution_id: 22222222-2222-2222-2222-222222222222

-- ---------------------------------------------------------------------------
-- INSTITUTIONS
-- ---------------------------------------------------------------------------

INSERT INTO institution (institution_id, institution_type, nces_id, status, created_by)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'HIGH_SCHOOL', '261630001234', 'MERGED_OUT', 'NCES_SYNC'),
  ('22222222-2222-2222-2222-222222222222', 'HIGH_SCHOOL', '261630005678', 'ACTIVE',     'NCES_SYNC');

-- ---------------------------------------------------------------------------
-- INSTITUTION VERSIONS (bitemporal)
-- Lincoln has two versions: the original name and the post-rename name.
-- Metro Career High has one version (stable name throughout).
-- ---------------------------------------------------------------------------

INSERT INTO institution_version (version_id, institution_id, valid_from, valid_to, name, name_normalized, address_line1, city, state, zip, county_fips, source)
VALUES
  -- Lincoln: original name (1992–2005)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111',
   '1992-09-01', '2005-07-31',
   'Lincoln High School', 'lincoln high school',
   '1234 Main St', 'Detroit', 'MI', '48201', '26163', 'NCES'),

  -- Lincoln: renamed (2005–2018, closed by merge)
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111',
   '2005-08-01', '2018-06-30',
   'Lincoln STEM Academy', 'lincoln stem academy',
   '1234 Main St', 'Detroit', 'MI', '48201', '26163', 'NCES'),

  -- Metro Career High (stable name, still active)
  ('cccccccc-cccc-cccc-cccc-cccccccccccc',
   '22222222-2222-2222-2222-222222222222',
   '1998-09-01', NULL,
   'Metro Career High School', 'metro career high school',
   '5678 Industrial Blvd', 'Detroit', 'MI', '48202', '26163', 'NCES');

-- ---------------------------------------------------------------------------
-- LIFECYCLE EVENTS
-- Two events for Lincoln: a rename in 2005, then a merge-out in 2018.
-- ---------------------------------------------------------------------------

INSERT INTO institution_lifecycle_event (event_id, institution_id, event_type, event_date, related_institution_id, notes, source_document, created_by)
VALUES
  -- 2005: Lincoln High School renamed to Lincoln STEM Academy
  ('dddddddd-dddd-dddd-dddd-dddddddddddd',
   '11111111-1111-1111-1111-111111111111',
   'RENAME', '2005-08-01', NULL,
   'Renamed as part of district STEM initiative',
   'https://michigan.gov/mde/announcements/2005/lincoln-rename',
   'NCES_SYNC'),

  -- 2018: Lincoln STEM Academy merged into Metro Career High
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   '11111111-1111-1111-1111-111111111111',
   'MERGE_OUT', '2018-06-30',
   '22222222-2222-2222-2222-222222222222',
   'Merged into Metro Career High per district consolidation plan',
   'https://michigan.gov/mde/announcements/2018/detroit-consolidation',
   'NCES_SYNC');

-- ---------------------------------------------------------------------------
-- PARTNER CROSSWALK
-- A Naviance mapping resolved via the matching pipeline.
-- ---------------------------------------------------------------------------

INSERT INTO partner_crosswalk (crosswalk_id, partner_id, partner_key, institution_id, confidence, resolution_method, is_verified, reviewed_by, reviewed_at)
VALUES
  ('ffffffff-ffff-ffff-ffff-ffffffffffff',
   'NAVIANCE', 'nav-lincoln-001',
   '11111111-1111-1111-1111-111111111111',
   1.000, 'EXACT', TRUE, 'data-ops-jane', '2023-04-15 14:30:00+00');

-- ---------------------------------------------------------------------------
-- SCHOOL YEAR REPORTS
-- A few years of data for Lincoln, showing how context changes over time.
-- ---------------------------------------------------------------------------

INSERT INTO school_year_report (report_id, institution_id, school_year, enrollment, ap_course_count, free_reduced_lunch_pct, graduation_rate, data_source)
VALUES
  ('10000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   2003, 1450, 6, 62.30, 78.50, 'NCES'),

  ('10000002-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   2009, 1120, 12, 58.10, 83.20, 'NCES'),

  ('10000003-0000-0000-0000-000000000003',
   '22222222-2222-2222-2222-222222222222',
   2019, 2200, 15, 55.00, 86.70, 'NCES');

-- ---------------------------------------------------------------------------
-- EXAMPLE QUERIES
-- These demonstrate the bitemporal lookup that the system performs.
-- ---------------------------------------------------------------------------

-- Q1: "What was this school called when a 2003 transcript was issued?"
--     Answer: Lincoln High School (the pre-rename version)
--
-- SELECT v.name, v.city, v.state
-- FROM institution_version v
-- WHERE v.institution_id = '11111111-1111-1111-1111-111111111111'
--   AND v.valid_from <= '2003-06-15'
--   AND (v.valid_to IS NULL OR v.valid_to > '2003-06-15');

-- Q2: "What was this school called when a 2009 transcript was issued?"
--     Answer: Lincoln STEM Academy (the post-rename version, same institution_id)
--
-- SELECT v.name, v.city, v.state
-- FROM institution_version v
-- WHERE v.institution_id = '11111111-1111-1111-1111-111111111111'
--   AND v.valid_from <= '2009-06-15'
--   AND (v.valid_to IS NULL OR v.valid_to > '2009-06-15');

-- Q3: "What school-year context did this institution have in 2009?"
--     Answer: enrollment 1120, 12 AP courses, 83.2% graduation rate
--
-- SELECT v.name, r.school_year, r.enrollment, r.ap_course_count, r.graduation_rate
-- FROM institution_version v
-- JOIN school_year_report r
--   ON r.institution_id = v.institution_id
--   AND r.school_year = 2009
-- WHERE v.institution_id = '11111111-1111-1111-1111-111111111111'
--   AND v.valid_from <= '2009-06-15'
--   AND (v.valid_to IS NULL OR v.valid_to > '2009-06-15');
