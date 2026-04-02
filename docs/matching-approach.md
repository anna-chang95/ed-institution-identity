# Matching Approach

How the system resolves a raw partner name — often abbreviated, truncated, or OCR-corrupted — to a canonical institution record.

---

## The core challenge

Partner data arrives in many forms. All of the following might refer to the same school:

| Raw input | Source |
|---|---|
| `St. Mary H.S.` | Naviance transcript |
| `Saint Mary High School` | Common App |
| `ST MARY HS DETROIT` | OCR scan |
| `St Marys High Sch` | Truncated field |
| `Sain Mary Hgh Schl` | OCR with multiple errors |

The system must match all of these to the same canonical `institution_id` — reliably, at scale, with an auditable confidence score.

---

## Stage 1: Normalization

Before any matching occurs, the raw name is normalized into a canonical form. Normalization is a pure function — no database calls, fully deterministic, independently testable.

### Abbreviation expansion

A curated map of abbreviations is applied via regex, case-insensitively:

| Abbreviation | Expands to |
|---|---|
| `H.S.`, `HS` | `high school` |
| `St.`, `St` | `saint` |
| `Mt.` | `mount` |
| `Ft.` | `fort` |
| `Acad.` | `academy` |
| `Prep.` | `preparatory` |
| `Tech.` | `technical` |
| `Voc.` | `vocational` |
| `Jr. H.S.` | `junior high school` |
| `Elem.` | `elementary` |
| `Intl.` | `international` |
| `Mem.` | `memorial` |
| `Mag.` | `magnet` |

The full map is defined in `src/pipeline/normalize.ts`.

### Normalization steps (in order)

1. Lowercase the entire string
2. Apply OCR corrections (only when source is flagged as OCR-derived)
3. Expand abbreviations using the map above
4. Strip punctuation — except internal hyphens (e.g. `Winston-Salem`)
5. Collapse whitespace

### Example

```
Input:   "St. Mary H.S., Detroit"
Step 1:  "st. mary h.s., detroit"
Step 2:  (no OCR corrections)
Step 3:  "saint mary high school, detroit"
Step 4:  "saint mary high school  detroit"
Step 5:  "saint mary high school detroit"
```

### OCR corrections

When a transcript is flagged as OCR-derived, additional substitutions are applied before abbreviation expansion:

| Pattern | Correction | Rationale |
|---|---|---|
| `0` before/after letters | `o` | Zero misread as letter O |
| `\brn\b` | `m` | "rn" misread as "m" |
| `I` before lowercase | `l` | Capital I misread as lowercase l |
| `1` before letters | `l` | One misread as l |

These are applied conservatively — only at word boundaries — to avoid corrupting legitimate names.

### Pre-computation

The normalized form is stored in `institution_version.name_normalized` at write time, not computed at query time. This means matching queries compare two pre-normalized strings — no runtime normalization cost on the canonical side.

---

## Stage 2: Matching cascade

Matching runs as a five-stage cascade. Each stage is only reached if the previous stage fails to produce a result above the auto-resolve threshold.

```
Input (normalized)
      │
      ▼
┌─────────────────────────┐
│  Stage 1: Exact match   │  confidence = 1.0  →  AUTO-RESOLVE
└─────────────────────────┘
      │ miss
      ▼
┌─────────────────────────┐
│  Stage 2: Phonetic      │  confidence ~0.85  →  AUTO-RESOLVE if ≥ 0.90
└─────────────────────────┘
      │ below threshold
      ▼
┌─────────────────────────┐
│  Stage 3: Fuzzy token   │  confidence proportional to score
└─────────────────────────┘
      │ below threshold
      ▼
┌─────────────────────────┐
│  Stage 4: Embedding     │  only runs if fuzzy score ≥ 0.75
└─────────────────────────┘
      │ below threshold
      ▼
┌─────────────────────────┐
│  Stage 5: Review queue  │  human resolution
└─────────────────────────┘
```

### Stage 1: Exact normalized match

Compares `input.nameNormalized` against `institution_version.name_normalized`, filtered to the same state. If the normalized strings are identical and the state matches, confidence is 1.0 and matching stops.

This stage resolves the majority of inputs — most abbreviation variants become identical strings after normalization.

### Stage 2: Phonetic match

Applies a phonetic key function to both the input and all state-filtered candidates. The phonetic key collapses vowels, merges common sound variants (`ph→f`, `ck→k`), and removes repeated characters. This catches OCR typos that survive normalization:

```
"Lincoln"  → phonetic key: "lncln"
"Lincohn"  → phonetic key: "lncln"  ✓ match
"Linkoln"  → phonetic key: "lncln"  ✓ match
```

In production, replace the simplified implementation in `match-pipeline.ts` with the `natural` npm package's `DoubleMetaphone` for better accuracy.

### Stage 3: Fuzzy token sort ratio

Splits both strings into tokens, sorts them alphabetically, rejoins, then computes Levenshtein similarity. Sorting tokens before comparison handles word-order variations cleanly:

```
"High School Saint Mary"  →  sorted: "high mary saint school"
"Saint Mary High School"  →  sorted: "high mary saint school"
                                      identical after sort → score: 1.0
```

This stage handles truncated names, extra words, and word-order differences that normalization alone cannot resolve.

### Stage 4: Embedding similarity

Computes cosine similarity between sentence embeddings of the normalized input and candidate. This catches semantic synonyms and harder variants that string-based methods miss.

The implementation in `match-pipeline.ts` is a stub — replace with a call to your embedding service (e.g. a fine-tuned `sentence-transformers` model via a Python sidecar or an external API).

Embeddings are expensive. This stage only runs when the fuzzy score is in the `[0.75, 0.90)` range — meaning the input is borderline, not clearly a match or a miss.

### Stage 5: Human review queue

Anything that does not clear the auto-resolve threshold (0.90) is written to a review queue with the top candidate and its score. A human reviewer sees the raw input, the top candidates on a map, and approves or corrects the match. The confirmed crosswalk is written back with `is_verified = true` and `resolution_method = MANUAL`.

---

## Confidence scoring

The confidence score is a weighted combination of three signals:

| Signal | Weight | Notes |
|---|---|---|
| Name token score | 0.55 | Token sort ratio — dominant signal |
| City match | 0.30 | Exact match = 1.0, unknown city = 0.5 (partial credit) |
| Phonetic match | 0.15 | Binary: same key = 1.0, different = 0.5 |

```
confidence = 0.55 × name_score + 0.30 × city_score + 0.15 × phonetic_score
```

Weights and thresholds are centralized in `src/types/index.ts` as `MATCH_WEIGHTS` and `THRESHOLDS` constants — changing them in one place affects the entire pipeline.

### Thresholds

| Threshold | Value | Meaning |
|---|---|---|
| `AUTO_RESOLVE` | 0.90 | Write crosswalk, no review needed |
| `EMBEDDING_TRIGGER` | 0.75 | Run embedding stage for borderline cases |
| `REVIEW_QUEUE` | 0.60 | Below this: skip embedding, go straight to review |

### Why recall over precision?

The thresholds are tuned to favor recall — it is worse to fail to match a school than to send a borderline match to human review. A missed match means a student's transcript cannot be contextualized, which directly degrades the product's core value. A borderline match goes to the review queue, not into production data unchecked.

---

## Geographic constraint

All candidate queries are filtered by state before running string comparisons. This serves two purposes:

1. **Performance** — reduces the candidate pool from ~27,000 schools nationwide to ~500–1,500 per state
2. **Accuracy** — prevents false positives from schools with similar names in different states

When state is unknown or cannot be normalized, the pipeline falls back to searching all candidates. In this case, the city signal becomes more important for disambiguation.

---

## Crosswalk caching

Once a partner key is resolved to a canonical institution, the mapping is written to `partner_crosswalk` with the confidence score and resolution method. Future lookups for the same `(partner_id, partner_key)` pair hit the cache directly — skipping the entire matching pipeline.

The cache is invalidated (confidence dropped, `is_verified` set to false) when a partner flags a match as incorrect via the API. This triggers a re-run of the full matching pipeline for that key.
