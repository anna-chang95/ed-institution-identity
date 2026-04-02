# Governance & Process

How institution data stays accurate, maintained, and trustworthy at scale — across many partners, many internal systems, and many sources of truth.

---

## The problem with institution data at scale

Institution data is not static. Schools rename, merge, close, and reopen. State education departments update their records. Partners send corrections. Internal teams find errors. Without deliberate process, the data degrades quietly — wrong names accumulate, merges go unrecorded, and downstream systems build on a foundation that is slowly becoming incorrect.

This document proposes the processes and governance structures that keep the institution registry reliable over time.

---

## Source hierarchy

When data from multiple sources conflicts, the following hierarchy determines which source wins:

| Priority | Source | Trust level |
|---|---|---|
| 1 | Manual review with source document | Highest — human confirmed with evidence |
| 2 | NCES / state education authority | Authoritative for official attributes |
| 3 | Verified partner data | Partner has confirmed their mapping |
| 4 | Unverified partner data | Lowest — stored in crosswalk only |

Lower-priority sources never overwrite higher-priority data without going through the review queue first. A partner cannot directly update a canonical institution record — they can only flag a discrepancy, which creates a review item.

---

## Automated ingestion

### NCES Common Core of Data (CCD)

The primary authoritative source for US public high schools. Updated annually by the National Center for Education Statistics.

- Nightly sync job checks for updates to the NCES dataset
- New schools are created as `institution` records with a corresponding `institution_version`
- Changed names or addresses trigger a new `institution_version` row (old row closed with `valid_to`)
- Status changes (closures, mergers) create `institution_lifecycle_event` records
- Conflicts with existing data are flagged for review — not auto-applied

### State education department feeds

Many states publish their own school directory data, sometimes more current than NCES. Where available, state feeds are ingested as a secondary source to catch changes before the annual NCES update.

### Partner data

Partner payloads are ingested into MongoDB staging (see `src/ingestion/ingest-partner.ts`) and processed by the matching pipeline. Partners contribute to crosswalk data, not to canonical institution records directly.

---

## Review queue

The review queue is the safety net for the entire system. Any match or change that cannot be automatically verified surfaces here for a human reviewer.

### What enters the review queue

- Matching pipeline results below the auto-resolve threshold (confidence < 0.90)
- Conflicts between incoming data and existing canonical records
- Partner flags on incorrect matches
- Lifecycle event proposals (renames, merges, closures) awaiting confirmation
- NCES updates that conflict with manually-verified data

### Priority tiers and SLAs

| Priority | Trigger | SLA |
|---|---|---|
| P1 | Affects active fraud detection | Same day |
| P2 | Affects a student's active enrollment | 48 hours |
| P3 | Historical transcript — no active downstream impact | 7 days |

### What a reviewer sees

- The raw partner input (name, city, state, date)
- The top 3 candidate matches with confidence scores
- A geographic map showing candidate locations
- The source document (for lifecycle events)
- A simple approve / correct / reject interface

### After review

- Approved: crosswalk written with `is_verified = true`, `resolution_method = MANUAL`
- Corrected: correct institution selected, crosswalk written, incorrect candidate flagged
- Rejected (no match): new institution record created if the school is legitimate but missing from the registry

---

## Change proposal workflow

Any internal system can propose a lifecycle event (rename, merge, closure). The proposal workflow prevents unvetted changes from reaching canonical data.

### Proposal requirements

Every lifecycle event proposal must include:

- `event_type` — RENAME, MERGE_IN, MERGE_OUT, SPLIT, CLOSURE, or REOPEN
- `event_date` — the real-world date the change took effect
- `source_document` — a URL or file reference as evidence (state announcement, news article, NCES record)
- `notes` — free-form context for reviewers

### Approval rules

| Event type | Approvals required |
|---|---|
| RENAME | 1 reviewer |
| CLOSURE | 2 reviewers |
| MERGE_IN / MERGE_OUT | 2 reviewers |
| SPLIT | 2 reviewers |
| REOPEN | 1 reviewer |

Merges and closures require two reviewers because they affect the most downstream data — crosswalks, school reports, and transcript records all reference the affected institution IDs.

### Audit trail

Every approved lifecycle event is immutable once written. The `institution_lifecycle_event` table is append-only — no updates, no deletes. The audit trail records who proposed the change, who approved it, when, and what source document was cited.

---

## Regular review cadence

Governance is not just reactive — it requires scheduled proactive review to catch drift before it affects downstream systems.

### Quarterly

- Reconcile the full institution registry against the latest NCES annual data drop
- Identify schools present in NCES but missing from the registry (gaps)
- Identify schools present in the registry but absent from NCES (possible closures)
- Review all institutions with `status = ACTIVE` but no `institution_version` updated in over 3 years

### Monthly

- Review all auto-resolved crosswalk matches with `confidence < 0.95` from the prior month
- Partner accuracy report: which partners have the highest correction rate?
- Review queue aging report: are any items approaching SLA breach?

### Weekly

- Review queue volume and aging report sent to the operations team
- Alert if review queue backlog exceeds 48 hours of capacity

### Ad hoc

- Partner-triggered correction pipeline (partner flags a wrong match → P1 review item)
- Data quality alert from the warehouse monitoring suite

---

## Partner feedback loop

Partners are often the first to notice a wrong match — they know their own data better than we do.

### How it works

1. Partner calls `POST /api/crosswalk/flag` with their `partner_id`, `partner_key`, and a reason
2. A P1 review queue item is created immediately
3. A reviewer resolves the item within the SLA
4. The corrected crosswalk is written back
5. Any downstream records that used the incorrect crosswalk are flagged for re-processing

### Accuracy tracking

Partner correction rates are tracked per partner over time. A partner with a consistently high correction rate signals a data quality issue on their side — an opportunity for a proactive integration improvement conversation.

---

## Data quality monitoring

### Great Expectations suite (warehouse layer)

A suite of data quality checks runs nightly against the `institution_at` materialized view:

- No institution with `status = ACTIVE` should have a `valid_to` date in the past
- No two version rows for the same institution should have overlapping date ranges
- Every institution should have at least one `institution_version` row
- `name_normalized` should never be empty or null
- `confidence` in `partner_crosswalk` should be within `[0.000, 1.000]`

### Freshness checks

- `institution_at` materialized view must refresh within 25 hours
- Alert if NCES sync job has not run within 26 hours
- Alert if the review queue has items older than their SLA tier

### Lineage

All downstream dbt models that consume `institution_at` declare it as a source dependency. Any schema change to the materialized view triggers a dbt compile check before deployment — preventing silent breakage in downstream models.

---

## Who owns what

| Responsibility | Owner |
|---|---|
| NCES sync job | Data engineering |
| Review queue tooling | Product engineering |
| Lifecycle event approvals | Data operations team |
| Partner integration quality | Solutions engineering |
| Warehouse monitoring suite | Data engineering |
| Quarterly reconciliation | Data engineering + data operations |
