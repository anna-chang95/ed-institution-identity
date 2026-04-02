# Warehouse & Analytics Notes

How institution data flows from the operational PostgreSQL database to the analytics layer — and how it powers Looker dashboards and university-facing insights.

---

## Architecture overview

```
PostgreSQL (operational)
  institution
  institution_version         ← bitemporal, append-only
  institution_lifecycle_event ← append-only event log
  partner_crosswalk
  school_year_report
        │
        │  nightly ETL
        ▼
Snowflake (warehouse)
  raw.institution_versions    ← full history, unmodified
  raw.partner_crosswalks
  raw.school_year_reports
        │
        │  dbt transformations
        ▼
  marts.institution_at        ← pre-joined, analyst-friendly
  marts.crosswalk_coverage    ← partner match quality metrics
  marts.school_context        ← transcript contextualization layer
        │
        ▼
Looker (dashboards)
  University stakeholder views
  Partner data quality reports
  Internal operations dashboards
```

---

## Why Snowflake

The operational PostgreSQL database is optimized for transactional workloads — single-record lookups, crosswalk writes, bitemporal range queries. It is not designed for the analytical queries that Looker needs: full table scans, complex aggregations across millions of transcript records, and joining school reports against demographic data.

Snowflake handles these workloads well because:

- **Columnar storage** — analytical queries that scan one or two columns across millions of rows are fast
- **Elastic compute** — warehouse size scales independently of storage; burst capacity for month-end reporting
- **Semi-structured data support** — the `VARIANT` column type stores raw partner payloads (JSON) natively, queryable with dot notation: `payload:school_name::string`
- **Native time-travel** — Snowflake retains a snapshot of every table for up to 90 days. This is separate from our bitemporal model: ours tracks business history ("what was the school called"), Snowflake's tracks system history ("what did our database say yesterday")
- **Zero-copy cloning** — create a full clone of a table for testing without duplicating storage costs

---

## The materialized view: institution_at

Analysts and Looker should never need to understand bitemporal query patterns. Getting the `valid_from / valid_to` range query wrong produces silently incorrect results — for example, double-counting a school that was renamed.

The `institution_at` materialized view encapsulates this logic in one place:

```sql
CREATE MATERIALIZED VIEW institution_at AS
SELECT
  i.institution_id,
  i.institution_type,
  i.nces_id,
  i.status                      AS current_status,
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
JOIN institution_version v ON v.institution_id = i.institution_id
LEFT JOIN school_year_report r
  ON  r.institution_id = i.institution_id
  AND r.school_year BETWEEN
      EXTRACT(YEAR FROM v.valid_from)::INT
      AND COALESCE(EXTRACT(YEAR FROM v.valid_to)::INT, 9999);
```

This is refreshed nightly: `REFRESH MATERIALIZED VIEW CONCURRENTLY institution_at`

In Snowflake, the equivalent is a dbt incremental model that appends new version rows and school year data as they arrive.

---

## dbt transformation layer

dbt sits between raw Snowflake tables and Looker. It manages all SQL transformations as version-controlled code — reviewable in pull requests, testable, and documented.

### Model structure

```
models/
├── staging/
│   ├── stg_institution_versions.sql     ← light cleaning, rename columns
│   ├── stg_partner_crosswalks.sql
│   └── stg_school_year_reports.sql
│
├── intermediate/
│   └── int_institution_at.sql           ← bitemporal join logic
│
└── marts/
    ├── institution_at.sql               ← final analyst-facing table
    ├── crosswalk_coverage.sql           ← partner match quality metrics
    └── school_context.sql               ← transcript contextualization
```

### Key mart: school_context

The `school_context` mart is the primary surface for transcript interpretation. Given a transcript with a school and a date, it returns the school's context for that year:

```sql
-- Example query a Looker explore would generate
SELECT
  institution_id,
  name_at_period,
  school_year,
  enrollment,
  ap_course_count,
  free_reduced_lunch_pct,
  graduation_rate
FROM marts.school_context
WHERE institution_id = '...'
  AND school_year = 2009
```

### Key mart: crosswalk_coverage

Tracks partner data quality over time — useful for the operations team and for partner conversations:

```sql
SELECT
  partner_id,
  COUNT(*)                                          AS total_crosswalks,
  AVG(confidence)                                   AS avg_confidence,
  SUM(CASE WHEN is_verified THEN 1 ELSE 0 END)
    / COUNT(*)::FLOAT                               AS verification_rate,
  SUM(CASE WHEN resolution_method = 'MANUAL' THEN 1 ELSE 0 END)
    / COUNT(*)::FLOAT                               AS manual_resolution_rate
FROM marts.crosswalk_coverage
GROUP BY partner_id
ORDER BY manual_resolution_rate DESC
```

A high `manual_resolution_rate` for a partner signals a data quality problem on their side.

---

## Snowflake time-travel for audit

Snowflake's `AT(timestamp =>)` syntax lets you query any table as it existed at a specific point in time:

```sql
-- What did our institution_at view contain on January 15th at 9am?
SELECT * FROM institution_at
AT(timestamp => '2024-01-15 09:00:00'::timestamp_tz)
WHERE institution_id = '...';
```

This adds a second, independent layer of time-travel on top of our bitemporal model:

| Layer | What it answers | Where it lives |
|---|---|---|
| Bitemporal model | What was this school called in the real world on date X? | PostgreSQL `institution_version` |
| Snowflake time-travel | What did our database say about this school on date X? | Snowflake system history |

The combination is useful for audit scenarios: "what information did we present to this university partner on this date?" — even if our data has since been corrected.

---

## Looker integration

### LookML structure

```
views/
├── institution_at.view.lkml         ← maps to marts.institution_at
├── school_context.view.lkml         ← transcript contextualization
└── crosswalk_coverage.view.lkml     ← partner data quality

explores/
├── institution_at.explore.lkml
└── school_context.explore.lkml
```

### University stakeholder dashboards

Looker dashboards for university partners surface:

- **School context by year** — AP course counts, enrollment, free/reduced lunch percentage for any school in a given year. Used to interpret a transfer student's GPA in context.
- **Peer school comparison** — compare a student's high school against peer institutions on key metrics
- **Transcript verification** — flag discrepancies between student-reported school data and transcript data from the same institution

### Internal operations dashboards

- **Review queue status** — volume, aging, SLA breach risk by priority tier
- **Partner data quality** — confidence distribution, manual resolution rate, correction rate per partner
- **Registry health** — institutions with missing version data, NCES sync status, data freshness

---

## ETL pipeline: PostgreSQL → Snowflake

### Nightly batch (primary)

1. Dump changed rows from PostgreSQL using a `updated_at` watermark
2. Load into Snowflake raw layer via `COPY INTO` from S3/GCS staging
3. Run dbt to refresh intermediate and mart models
4. Refresh Looker PDTs (persistent derived tables) if needed
5. Run Great Expectations data quality suite
6. Alert on failures — do not silently pass bad data downstream

### Change data capture (future)

For lower latency — when institution data needs to flow to Snowflake within minutes rather than hours — replace the nightly batch with CDC using Debezium on PostgreSQL. Events stream to Kafka, consumed by a Snowflake Snowpipe. This is not needed at current scale but is a natural next step as ingestion volume grows.

---

## Data retention and compliance

- Raw partner payloads in MongoDB: retained for 2 years, then archived to cold storage
- `institution_lifecycle_event`: retained indefinitely — this is the permanent audit log
- `institution_version`: retained indefinitely — historical record required for transcript interpretation
- Snowflake time-travel: 90 days (Snowflake Enterprise default)
- dbt model run artifacts: retained for 1 year for lineage auditing
