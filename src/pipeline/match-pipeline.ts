// Matching pipeline
// Runs a multi-stage cascade to find the best matching canonical institution
// for a normalized input. Cheap stages run first; expensive stages only
// when needed.
//
// Stages:
//   1. Exact normalized match
//   2. Phonetic match (Double Metaphone approximation)
//   3. Fuzzy token match (token sort ratio)
//   4. Embedding similarity (stubbed — replace with real model in production)
//
// This module is designed to be testable without a real database.
// In tests, pass mock candidates directly to computeConfidence() or
// runMatchPipeline() via the candidates parameter.

import {
  MatchCandidate,
  MatchInput,
  MatchResult,
  ResolutionMethod,
  THRESHOLDS,
  MATCH_WEIGHTS,
} from '../types';

// ---------------------------------------------------------------------------
// tokenSortRatio
// A simplified token sort ratio implementation.
// Splits both strings into tokens, sorts them, rejoins, then computes
// character-level similarity. Handles word-order variations well.
// e.g. "High School Saint Mary" vs "Saint Mary High School" → 1.0
// ---------------------------------------------------------------------------

function tokenSortRatio(a: string, b: string): number {
  const sortTokens = (s: string) =>
    s.split(/\s+/).sort().join(' ');

  const sortedA = sortTokens(a);
  const sortedB = sortTokens(b);

  return levenshteinSimilarity(sortedA, sortedB);
}

// ---------------------------------------------------------------------------
// levenshteinSimilarity
// Returns a 0–1 similarity score based on Levenshtein edit distance.
// 1.0 = identical, 0.0 = completely different.
// ---------------------------------------------------------------------------

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) =>
    Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(
              matrix[i - 1][j - 1] + 1,  // substitution
              matrix[i][j - 1] + 1,       // insertion
              matrix[i - 1][j] + 1        // deletion
            );
    }
  }

  const distance = matrix[b.length][a.length];
  return 1 - distance / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// phoneticKey
// A simplified phonetic key generator (approximates Double Metaphone).
// Maps common sound patterns to canonical forms so that
// "Lincohn" and "Lincoln" produce the same key.
// In production, replace with the `natural` npm package's DoubleMetaphone.
// ---------------------------------------------------------------------------

export function phoneticKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ph/g, 'f')        // ph → f  (phonetic)
    .replace(/ck/g, 'k')        // ck → k
    .replace(/gh/g, 'g')        // gh → g
    .replace(/wh/g, 'w')        // wh → w
    .replace(/ohn/g, 'on')      // ohn → on  (Lincohn → Lincon)
    .replace(/oln/g, 'on')      // oln → on  (Lincoln → Lincon)
    .replace(/[aeiou]/g, 'a')   // collapse all vowels to 'a'
    .replace(/[^a-z]/g, '')     // strip non-alpha
    .replace(/(.)\1+/g, '$1')   // collapse repeated chars
    .substring(0, 8);           // keep first 8 chars
}

// ---------------------------------------------------------------------------
// computeConfidence
// Combines name, city, and phonetic signals into a single confidence score.
// Weights are defined in src/types/index.ts as MATCH_WEIGHTS.
// ---------------------------------------------------------------------------

export function computeConfidence(
  input:     MatchInput,
  candidate: MatchCandidate
): number {
  // Name token score
  const nameScore = tokenSortRatio(input.nameNormalized, candidate.nameNormalized);

  // City score — exact match only (normalized)
  const cityScore =
    input.city && candidate.city
      ? input.city.toLowerCase() === candidate.city.toLowerCase()
        ? 1.0
        : 0.0
      : 0.5; // unknown city — partial credit, not zero

  // Phonetic score
  const phoneticScore =
    phoneticKey(input.nameNormalized) === phoneticKey(candidate.nameNormalized)
      ? 1.0
      : 0.5;

  const confidence =
    MATCH_WEIGHTS.nameToken * nameScore +
    MATCH_WEIGHTS.city      * cityScore +
    MATCH_WEIGHTS.phonetic  * phoneticScore;

  // Round to 3 decimal places to match DB column precision
  return Math.round(confidence * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// embeddingSimilarity (stub)
// In production, this calls a fine-tuned sentence embedding model
// (e.g. sentence-transformers via a Python sidecar or an API).
// Returns cosine similarity between the input and candidate embeddings.
// ---------------------------------------------------------------------------

async function embeddingSimilarity(
  _input:     MatchInput,
  _candidate: MatchCandidate
): Promise<number> {
  // Stub: in production, call your embedding service here.
  // e.g. POST /embed { text: input.nameNormalized + ' ' + input.city }
  // and compare cosine similarity against pre-computed candidate embeddings.
  return 0.0;
}

// ---------------------------------------------------------------------------
// runMatchPipeline
// Main export. Runs the full matching cascade against a list of candidates.
// Returns the best match result, or null if nothing clears the review threshold.
//
// In tests, pass mock candidates directly.
// In production, candidates come from a DB query filtered by state.
// ---------------------------------------------------------------------------

export async function runMatchPipeline(
  input:      MatchInput,
  candidates: MatchCandidate[]
): Promise<MatchResult | null> {

  // --- Stage 1: Exact normalized match ---
  const exactMatch = candidates.find(
    c => c.nameNormalized === input.nameNormalized &&
         c.state?.toUpperCase() === input.state?.toUpperCase()
  );

  if (exactMatch) {
    return {
      institutionId:    exactMatch.institutionId,
      confidence:       1.0,
      resolutionMethod: ResolutionMethod.EXACT,
    };
  }

  // --- Stage 2 & 3: Phonetic + Fuzzy scoring across all candidates ---
  // Filter to same state first (cheap DB-side filter in production)
  const stateCandidates = input.state
    ? candidates.filter(c => c.state?.toUpperCase() === input.state?.toUpperCase())
    : candidates;

  let bestCandidate: MatchCandidate | null = null;
  let bestScore = 0;

  // Check phonetic match first
  const phoneticInput = phoneticKey(input.nameNormalized);
  for (const candidate of stateCandidates) {
    if (phoneticKey(candidate.nameNormalized) === phoneticInput) {
      const score = computeConfidence(input, candidate);
      if (score > bestScore) {
        bestScore     = score;
        bestCandidate = candidate;
      }
    }
  }

  // Fuzzy token match across all state candidates
  for (const candidate of stateCandidates) {
    const score = computeConfidence(input, candidate);
    if (score > bestScore) {
      bestScore     = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestScore >= THRESHOLDS.AUTO_RESOLVE) {
    return {
      institutionId:    bestCandidate.institutionId,
      confidence:       bestScore,
      resolutionMethod: ResolutionMethod.FUZZY,
    };
  }

  // --- Stage 4: Embedding similarity (expensive — only for borderline cases) ---
  if (bestCandidate && bestScore >= THRESHOLDS.EMBEDDING_TRIGGER) {
    const embScore = await embeddingSimilarity(input, bestCandidate);
    const blended  = Math.max(bestScore, embScore);

    if (blended >= THRESHOLDS.AUTO_RESOLVE) {
      return {
        institutionId:    bestCandidate.institutionId,
        confidence:       Math.round(blended * 1000) / 1000,
        resolutionMethod: ResolutionMethod.EMBEDDING,
      };
    }
  }

  // --- No auto-resolution: surface for human review ---
  return null;
}
