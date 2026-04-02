# Diagrams

Three diagrams illustrating the data model, lifecycle, and resolution flow.
All diagrams render natively in GitHub.

---

## 1. Entity relationship overview

Six tables in PostgreSQL. `institution` is the stable center — everything else references it.

```mermaid
erDiagram
    INSTITUTION {
        uuid institution_id PK
        enum institution_type
        varchar nces_id
        enum status
        timestamptz created_at
        varchar created_by
    }

    INSTITUTION_VERSION {
        uuid version_id PK
        uuid institution_id FK
        date valid_from
        date valid_to
        text name
        text name_normalized
        text city
        char state
        varchar zip
        char county_fips
        varchar source
    }

    INSTITUTION_LIFECYCLE_EVENT {
        uuid event_id PK
        uuid institution_id FK
        enum event_type
        date event_date
        uuid related_institution_id FK
        text notes
        text source_document
        varchar created_by
    }

    PARTNER_CROSSWALK {
        uuid crosswalk_id PK
        varchar partner_id
        text partner_key
        uuid institution_id FK
        numeric confidence
        enum resolution_method
        boolean is_verified
        varchar reviewed_by
        timestamptz reviewed_at
    }

    SCHOOL_YEAR_REPORT {
        uuid report_id PK
        uuid institution_id FK
        smallint school_year
        int enrollment
        smallint ap_course_count
        numeric free_reduced_lunch_pct
        numeric graduation_rate
        varchar data_source
    }

    INSTITUTION ||--o{ INSTITUTION_VERSION : "has versions"
    INSTITUTION ||--o{ INSTITUTION_LIFECYCLE_EVENT : "has events"
    INSTITUTION ||--o{ PARTNER_CROSSWALK : "has crosswalks"
    INSTITUTION ||--o{ SCHOOL_YEAR_REPORT : "has reports"
    INSTITUTION ||--o{ INSTITUTION_LIFECYCLE_EVENT : "related to"
```

---

## 2. Bitemporal lifecycle — institution identity over time

How a single institution moves through rename and merge events while keeping the same `institution_id`.

```mermaid
timeline
    title Lincoln High School — identity over time (institution_id stays the same)

    section 1992
        Sep 1992 : Institution created
                 : name = "Lincoln High School"
                 : valid_from = 1992-09-01
                 : valid_to = 2005-07-31

    section 2005
        Aug 2005 : RENAME event recorded
                 : Old version row closed (valid_to = 2005-07-31)
                 : New version row opened
                 : name = "Lincoln STEM Academy"
                 : valid_from = 2005-08-01
                 : valid_to = NULL (active)

    section 2009
        Jun 2009 : Transcript issued
                 : Query date = 2009-06-15
                 : Returns "Lincoln STEM Academy"
                 : Same institution_id as 1992

    section 2018
        Jun 2018 : MERGE_OUT event recorded
                 : related_institution_id = Metro Career High
                 : Status set to MERGED_OUT
                 : Version row closed (valid_to = 2018-06-30)
```

---

## 3. Transcript resolution flow

How a raw partner payload moves through the system to a resolved canonical institution record.

```mermaid
flowchart TD
    A([Partner payload arrives]) --> B[Write raw payload to MongoDB\nas-is, no transformation]
    B --> C[Normalize name\nexpand abbreviations · strip noise · OCR corrections]
    C --> D{Crosswalk\ncache hit?}

    D -- Yes, verified &\nconfidence ≥ 0.90 --> E[Fetch institution_version\nvalid on transcript date]
    D -- No --> F[Stage 1: Exact normalized match\ncompare name_normalized + state]

    F -- Hit --> G[confidence = 1.0]
    F -- Miss --> H[Stage 2: Phonetic match\nDouble Metaphone · same state filter]

    H -- Hit --> I[confidence ~0.85]
    H -- Miss --> J[Stage 3: Fuzzy token match\ntoken sort ratio · Levenshtein]

    J -- Score ≥ 0.90 --> K[confidence = score]
    J -- Score 0.75–0.90 --> L[Stage 4: Embedding similarity\ncosine similarity · expensive]
    J -- Score < 0.75 --> M

    L -- Score ≥ 0.90 --> K
    L -- Score < 0.90 --> M

    G --> N[Write crosswalk\nresolution_method = EXACT]
    I --> N
    K --> N

    N --> E
    M([Enqueue for human review\nP1 · P2 · P3 by impact])

    E --> O{Version found\nfor transcript date?}
    O -- Yes --> P([RESOLVED\nreturn name_at_date · institution_type · confidence])
    O -- No --> Q([DATE_GAP\ninstitution found · no version covers this date])

    style A fill:#E1F5EE,stroke:#0F6E56,color:#085041
    style P fill:#E1F5EE,stroke:#0F6E56,color:#085041
    style M fill:#FAECE7,stroke:#993C1D,color:#712B13
    style Q fill:#FAEEDA,stroke:#854F0B,color:#633806
```

---

## Key design notes

**Why `institution_id` never changes**
A rename is just a new `institution_version` row — the ID stays the same. Partner crosswalks, school reports, and transcript records all continue to reference the same ID without any migration.

**Why the crosswalk is checked first**
Once a partner key has been resolved and verified, re-running the full matching pipeline is wasteful. The crosswalk acts as a cache — the matching pipeline only runs on first encounter or after a partner correction.

**Why MongoDB for staging**
Raw partner payloads arrive in unpredictable shapes. Writing them to MongoDB before normalization preserves the original data for audit and gives the pipeline flexibility to handle any incoming shape without corrupting canonical PostgreSQL records.
