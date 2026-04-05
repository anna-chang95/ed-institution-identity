# High School Institution Identity & Change Over Time

A data model, matching pipeline, and resolution system for reliably identifying high school institutions across time — despite renames, merges, closures, and noisy transcript data.

Built as a take-home case study for Edvisorly's Sr. Software Engineer / Data Engineer role.

---

## Problem

Transfer students often submit transcripts that are many years old. The high school named on a 2009 transcript may have since been renamed, merged into another school, or closed entirely. We need to answer two questions reliably:

1. **What institution is this transcript referring to?** (matching against noisy, abbreviated, or OCR-corrupted names)
2. **What was that institution at the time the transcript was issued?** (identity over time)

A wrong answer here cascades into broken school reports, failed fraud detection, and incorrect dual-enrollment classification.

---

## Architecture Overview

Raw partner data arrives in unpredictable shapes — different fields, abbreviations, and formats per partner. The system uses a two-database architecture to handle this cleanly:

```
Partner payload (raw, messy)
        │
        ▼
   MongoDB (staging)
   Raw payloads stored as-is.
   No structure enforced yet.
        │
        ▼
   Normalization pipeline
   Expand abbreviations, strip noise,
   correct OCR artifacts.
        │
        ▼
   Matching pipeline
   Exact → Phonetic → Fuzzy → Embedding → Review queue
        │
        ▼
   PostgreSQL (canonical)
   Clean institution records,
   bitemporal versions, crosswalks.
        │
        ▼
   Resolution
   "What was this school on date X?"
```

**Why two databases?**
- **MongoDB** acts as the receiving dock — raw partner payloads land here exactly as sent, preserving the original data before any transformation. This protects the canonical store from messy input and gives us a full audit trail of what partners actually sent.
- **PostgreSQL** is the canonical store — clean, structured, relational. All bitemporal queries, lifecycle events, and crosswalk resolution happen here.

---

## Data Model

Six core tables in PostgreSQL:

| Table | Purpose |
|---|---|
| `institution` | Stable canonical identity. The ID never changes. |
| `institution_version` | Bitemporal attributes (name, address). Valid from/to ranges. |
| `institution_lifecycle_event` | Append-only log of renames, merges, closures. |
| `partner_crosswalk` | Maps a partner's key or name to our canonical ID. |
| `school_year_report` | Annual statistics per institution (AP courses, enrollment, demographics). |

One MongoDB collection:

| Collection | Purpose |
|---|---|
| `raw_partner_payloads` | Raw inbound data from partners, stored before normalization. |

### Bitemporal pattern

Every name, address, and attribute change is stored as a new `institution_version` row — the old row is never overwritten. Querying "what was this school on a given date" is a single range query:

```sql
SELECT * FROM institution_version
WHERE institution_id = $1
  AND valid_from <= $2
  AND (valid_to IS NULL OR valid_to > $2)
```

This means a transcript from 2009 referencing "Lincoln STEM Academy" correctly resolves to that name — even though the school has since been renamed or closed.

---

## Matching Pipeline

Matching runs as a cascade — cheap stages first, expensive stages only when needed:

1. **Exact normalized match** — expand abbreviations, strip punctuation, compare. Confidence: 1.0
2. **Phonetic match** (Double Metaphone) — catches OCR typos and phonetic variants. Confidence: ~0.85
3. **Fuzzy token match** (token sort ratio) — handles word-order variation and truncation. Confidence: proportional to score
4. **Embedding similarity** — semantic matching for hard cases. Confidence: proportional to score
5. **Human review queue** — anything below threshold surfaces for manual resolution

See [`docs/matching-approach.md`](docs/matching-approach.md) for full normalization rules, confidence weights, and threshold rationale.

---

## Repository Structure

```
hs-institution-identity/
│
├── README.md                        ← you are here
├── DECISIONS.md                     ← key design tradeoffs and alternatives considered
│
├── prisma/
│   └── schema.prisma                ← PostgreSQL schema (all canonical tables)
│
├── migrations/
│   └── 001_initial.sql              ← raw SQL equivalent of the Prisma schema
│
├── src/
│   ├── lib/
│   │   ├── postgres.ts              ← Prisma client singleton
│   │   └── mongo.ts                 ← MongoDB client
│   │
│   ├── ingestion/
│   │   └── ingest-partner.ts        ← receives raw partner payload → writes to MongoDB
│   │
│   ├── pipeline/
│   │   ├── normalize.ts             ← name normalization (abbreviations, OCR, whitespace)
│   │   ├── match-pipeline.ts        ← matching cascade with confidence scoring
│   │   └── resolve.ts               ← resolveInstitutionAtDate() — core resolution function
│   │
│   ├── types/
│   │   └── index.ts                 ← shared TypeScript interfaces
│   │
│   └── __tests__/
│       ├── normalize.test.ts        ← normalization unit tests
│       ├── match-pipeline.test.ts   ← matching tests with mock institution data
│       └── resolve.test.ts          ← date-resolution tests with mock DB
│
├── diagrams/
│   └── README.md                    ← Three diagrams(data model, lifecycle and resolution)
│
└── docs/
    ├── matching-approach.md         ← normalization rules, confidence weights, thresholds
    ├── governance.md                ← process, SLAs, source hierarchy, review queue
    └── warehouse-notes.md           ← Snowflake/Looker layer, dbt pattern, analytics
```

---

## Running the Tests

No database setup required. All tests run against mock data.

```bash
git clone https://github.com/<your-username>/hs-institution-identity
cd hs-institution-identity
npm install
npm test
```

Expected output:

```
PASS src/__tests__/normalize.test.ts
PASS src/__tests__/match-pipeline.test.ts
PASS src/__tests__/resolve.test.ts

Test Suites: 3 passed, 3 total
Tests:       18 passed, 18 total
```

---

## Running Against Real Databases (Optional)

To run the full pipeline against real PostgreSQL and MongoDB instances:

```bash
cp .env.example .env
# Fill in your DATABASE_URL and MONGODB_URI

npx prisma migrate dev
npx prisma db seed

npm run dev
```

A `docker-compose.yml` for local database setup is planned for a future iteration.

---

## Key Design Decisions

See [`DECISIONS.md`](DECISIONS.md) for the full tradeoff analysis. Summary:

- **Bitemporal versioning over mutable records** — history is never overwritten, only extended
- **Stable canonical IDs** — institution identity survives all lifecycle events
- **Partner crosswalks as a cache with confidence** — partner noise never contaminates canonical data
- **Multi-stage matching cascade** — recall-first, with human review as the safety net
- **MongoDB as staging, PostgreSQL as canonical** — raw data preserved, clean data structured

---

## Diagrams

| Diagram | Description |
|---|---|
| `Entity relationship overview` | Entity relationships across all six tables |
| `Bitemporal lifecycle` | How a school moves through rename → merge → closure |
| `Transcript resolution flow` | How a raw transcript resolves to a canonical institution record |
