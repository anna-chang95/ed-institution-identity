// Institution resolution
// The core function of the entire system.
// Given a partner payload and a transcript date, resolves:
//   1. Which canonical institution does this refer to?
//   2. What was that institution called on that date?
//
// Designed to be testable without a real database — accepts an optional
// `db` parameter that can be replaced with mock data in tests.

import {
  ResolutionResult,
  ResolutionStatus,
  ResolutionMethod,
  MatchCandidate,
  MatchInput,
  PartnerCrosswalk,
  InstitutionVersion,
  InstitutionType,
  InstitutionStatus,
  THRESHOLDS,
} from '../types';
import { normalizeName, normalizeCity, normalizeState } from './normalize';
import { runMatchPipeline } from './match-pipeline';

// ---------------------------------------------------------------------------
// DB interface
// Abstracts all database calls so resolve.ts can be tested without a real DB.
// In production, pass the real Prisma-backed implementation.
// In tests, pass a mock that returns controlled data.
// ---------------------------------------------------------------------------

export interface ResolutionDb {
  // Look up an existing verified crosswalk for this partner key
  findCrosswalk(
    partnerId:  string,
    partnerKey: string
  ): Promise<PartnerCrosswalk | null>;

  // Fetch institution version valid on a specific date
  findVersionAtDate(
    institutionId:  string,
    transcriptDate: Date
  ): Promise<InstitutionVersion | null>;

  // Fetch all candidate institutions in a state for matching
  findCandidatesByState(
    state: string
  ): Promise<MatchCandidate[]>;

  // Fetch all candidates (fallback when state is unknown)
  findAllCandidates(): Promise<MatchCandidate[]>;

  // Write a new crosswalk record
  upsertCrosswalk(crosswalk: Omit<PartnerCrosswalk, 'id'>): Promise<void>;

  // Add to the human review queue
  enqueueForReview(input: MatchInput, topScore: number): Promise<void>;

  // Fetch institution type and status
  findInstitution(institutionId: string): Promise<{
    institutionType: InstitutionType;
    status:          InstitutionStatus;
  } | null>;
}

// ---------------------------------------------------------------------------
// resolveInstitutionAtDate
// Main export. The core function of the system.
//
// Flow:
//   1. Check crosswalk cache (cheap)
//   2. If miss, normalize input and run matching pipeline
//   3. Once institution_id is resolved, fetch version valid on transcript date
// ---------------------------------------------------------------------------

export async function resolveInstitutionAtDate(
  partnerId:      string,
  partnerKey:     string,
  nameRaw:        string,
  cityRaw:        string | null,
  stateRaw:       string | null,
  transcriptDate: Date,
  db:             ResolutionDb,
): Promise<ResolutionResult> {

  // --- Step 1: Crosswalk cache lookup ---
  const cached = await db.findCrosswalk(partnerId, partnerKey);

  let institutionId: string | null = null;
  let confidence:    number        = 0;

  if (cached && cached.isVerified && cached.confidence >= THRESHOLDS.AUTO_RESOLVE) {
    // Cache hit — skip matching entirely
    institutionId = cached.institutionId;
    confidence    = cached.confidence;
  } else {
    // --- Step 2: Run matching pipeline ---
    const nameNormalized = normalizeName(nameRaw);
    const city           = normalizeCity(cityRaw);
    const state          = normalizeState(stateRaw);

    const matchInput: MatchInput = {
      partnerId,
      partnerKey,
      nameRaw,
      nameNormalized,
      city,
      state,
      transcriptDate,
    };

    const candidates = state
      ? await db.findCandidatesByState(state)
      : await db.findAllCandidates();

    const matchResult = await runMatchPipeline(matchInput, candidates);

    if (!matchResult) {
      // No match above threshold — send to human review
      await db.enqueueForReview(matchInput, confidence);
      return {
        status:  ResolutionStatus.NEEDS_REVIEW,
        message: `No match found above threshold for "${nameRaw}" in ${state ?? 'unknown state'}`,
      };
    }

    institutionId = matchResult.institutionId;
    confidence    = matchResult.confidence;

    // Persist the crosswalk so future lookups hit the cache
    await db.upsertCrosswalk({
      partnerId,
      partnerKey,
      institutionId,
      confidence,
      resolutionMethod: matchResult.resolutionMethod,
      isVerified:       matchResult.resolutionMethod === ResolutionMethod.EXACT,
      reviewedBy:       null,
      reviewedAt:       null,
    });
  }

  // --- Step 3: Fetch version valid on transcript date ---
  const version = await db.findVersionAtDate(institutionId, transcriptDate);

  if (!version) {
    // Institution exists but no version covers this date — data gap
    return {
      status:        ResolutionStatus.DATE_GAP,
      institutionId,
      confidence,
      message: `Institution found (${institutionId}) but no version covers ${transcriptDate.toISOString().slice(0, 10)}`,
    };
  }

  const institution = await db.findInstitution(institutionId);

  return {
    status:          ResolutionStatus.RESOLVED,
    institutionId,
    nameAtDate:      version.name,
    institutionType: institution?.institutionType,
    confidence,
  };
}
