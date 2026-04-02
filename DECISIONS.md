# Design Decisions & Tradeoffs

This document explains the key architectural choices made in this system, what alternatives were considered, and why each decision was made. These are the kinds of tradeoffs that matter in a real production environment — not just what was built, but why.

---

## 1. Bitemporal versioning over mutable records

### What was decided
Every institution attribute (name, address, status) is stored in a separate `institution_version` table with `valid_from` and `valid_to` date ranges. When a school is renamed, we close the current version row and open a new one. The old row is never deleted or overwritten.

### Why
The core problem requires answering: *"what was this school when this transcript was issued?"* A transcript from 2009 must resolve to the school's name and attributes as they existed in 2009 — not today.

If we simply updated the name in place (mutable records), that historical answer becomes impossible. There is no way to recover what the record said before the update.

### Alternative considered: full event sourcing
Store every change as an event (e.g., `SchoolRenamed`, `SchoolMerged`). Reconstruct the state at any point by replaying events from the beginning.

**Why not chosen:** Event sourcing gives richer audit detail, but querying "state at date X" requires replaying potentially hundreds of events per institution. This is slow, complex to implement correctly, and hard for analysts to query directly. The bitemporal pattern gives us the same historical query capability with a single SQL range query — far simpler for the team to maintain and for the warehouse to consume.

### Alternative considered: SCD Type 2 on the main table
Add `valid_from`, `valid_to`, and `is_current` columns directly to the `institution` table, creating a new row for each change.

**Why not chosen:** This works for simple cases but breaks referential integrity when the primary key changes between versions. It also makes "get current record" queries awkward (always requires filtering on `is_current = true`). Separating identity (`institution`) from attributes (`institution_version`) keeps the schema cleaner and foreign keys always valid.

---

## 2. Stable canonical IDs that survive all lifecycle events

### What was decided
The `institution_id` (UUID) is assigned once and never changes — not for renames, not for merges, not for closures. It is the permanent identity of the institution.

### Why
Partner crosswalks, school reports, transcript records, and fraud detection signals all reference `institution_id`. If that ID changed during a rename, every downstream system would break or require a migration. A stable ID means a rename is just a new version row — nothing downstream needs to change.

### Alternative considered: use NCES ID as the primary key
The National Center for Education Statistics assigns IDs to most US public schools. Using this as the primary key would make external joins easier.

**Why not chosen:** NCES IDs are not available for all schools (private schools, international schools, closed schools often lack them). They also occasionally change when schools are restructured. Using an internal UUID as the primary key, with NCES ID as a nullable reference column, gives us full control over identity while still supporting NCES-based lookups.

---

## 3. Partner crosswalks as a cache with confidence, not source of truth

### What was decided
The `partner_crosswalk` table stores the mapping between a partner's identifier or raw name and our canonical `institution_id`. It includes a `confidence` score (0–1), a `resolution_method`, and an `is_verified` flag. Partners never write directly to institution tables.

### Why
Partners are unreliable sources of institution data. They abbreviate names differently, use internal IDs that mean nothing outside their system, and occasionally send incorrect data. If we allowed partner data to directly update canonical records, one bad partner payload could corrupt data that affects every other partner and every downstream system.

The crosswalk table acts as a firewall. Partner noise stays in the crosswalk layer. Canonical data only changes through a controlled, reviewed process.

The confidence score allows downstream consumers to set their own thresholds — a fraud detection system might require `confidence >= 0.95`, while a reporting dashboard might accept `confidence >= 0.80`.

### Alternative considered: write partner ID directly to institution table
Add a column per partner (e.g., `naviance_id`, `common_app_id`) to the institution table.

**Why not chosen:** This creates a new column every time a new partner is onboarded. It also makes it impossible to store multiple name variants from the same partner, or to track confidence and resolution method per mapping. The crosswalk table scales to any number of partners without schema changes.

---

## 4. Multi-stage matching cascade (recall-first)

### What was decided
Matching runs as a five-stage cascade: exact normalized match → phonetic match → fuzzy token match → embedding similarity → human review queue. Each stage is only reached if the previous stage fails to produce a high-confidence match.

The system is explicitly tuned for **recall over precision** — it is worse to fail to match a school that exists than to send a borderline match to human review. The review queue is the safety net, not an edge case.

### Why
The problem statement explicitly calls out that recall is especially important. A missed match means a student's transcript cannot be interpreted in context — directly impacting the product's core value. A false positive (wrong match) is caught during human review before it affects downstream systems.

### Alternative considered: embeddings-first
Run all inputs through a sentence embedding model and match by cosine similarity. Highest recall ceiling.

**Why not chosen:** Embedding inference is 10–100x more expensive per query than exact or fuzzy matching. For a system that may process thousands of transcripts in a batch, running embeddings on every input is not sustainable. The cascade means ~80% of inputs resolve at the exact or fuzzy stage, and embeddings are reserved for genuinely ambiguous cases.

### Alternative considered: single fuzzy pass with a fixed threshold
Run RapidFuzz token sort ratio on every input, auto-resolve above a threshold, drop below.

**Why not chosen:** A single fuzzy pass misses phonetic variants ("Lincohn" vs "Lincoln" from OCR), word-order variations that fuzzy handles poorly, and semantic equivalents that only embeddings catch. The cascade handles each failure mode with the right tool.

---

## 5. MongoDB as staging layer, PostgreSQL as canonical store

### What was decided
Raw partner payloads are written to MongoDB exactly as received, before any normalization or validation. The normalized, resolved data lives in PostgreSQL.

### Why
Partner data arrives in unpredictable shapes — different fields, formats, and abbreviations per partner. Forcing raw input into a strict relational schema immediately would either reject valid data (too strict) or corrupt the canonical store (too lenient).

MongoDB as a staging layer preserves the original payload for audit purposes and gives the pipeline flexibility to handle any incoming shape. Once the data is normalized and resolved, the clean result moves to PostgreSQL where relational integrity, bitemporal queries, and complex joins are all first-class.

This is a standard staging pattern in production data pipelines — the separation of "raw" and "canonical" zones is well established in data engineering practice.

### Alternative considered: PostgreSQL only, with a JSONB staging column
Store raw payloads in a PostgreSQL table with a `JSONB` column, then process them in place.

**Why not chosen:** PostgreSQL JSONB is capable, but it lacks MongoDB's flexibility for truly schema-less ingestion at scale. More importantly, mixing raw staging and canonical data in the same database creates operational risk — a pipeline bug affecting the staging table is one query away from affecting canonical data. Separate databases enforce a hard boundary.

### Alternative considered: message queue (e.g., Kafka) as the staging layer
Stream partner payloads through Kafka, consume and normalize in real time.

**Why not chosen:** Kafka adds significant operational complexity and is appropriate when real-time stream processing is a hard requirement. For this use case, batch ingestion with a MongoDB staging layer is sufficient and far simpler to operate and debug. This can be revisited if ingestion volume or latency requirements change.

---

## 6. Warehouse-ready design (Snowflake + dbt + Looker)

### What was decided
The operational tables (PostgreSQL) are designed to be append-friendly and event-sourced where possible. A nightly materialized view (`institution_at`) pre-joins the bitemporal columns for analysts. Warehouse consumers never query raw lifecycle tables.

### Why
The JD calls out Looker dashboards and data-driven experiences for university stakeholders. Analysts and Looker should never need to understand bitemporal query patterns or join lifecycle event tables. The `institution_at` materialized view flattens all of that into a simple, query-friendly surface.

Snowflake's `AT(timestamp =>)` time-travel syntax adds a second layer of audit capability on top of our bitemporal model — ours tracks business history (what the school was), Snowflake's tracks system history (what our database said at any point in time).

### Alternative considered: expose raw tables to the warehouse
Let analysts query `institution_version` and `institution_lifecycle_event` directly.

**Why not chosen:** Bitemporal queries require understanding `valid_from / valid_to` semantics. Getting this wrong in an analyst query produces silently incorrect results — for example, double-counting a school that was renamed. Encapsulating the logic in a materialized view means there is one correct implementation that everyone uses.
