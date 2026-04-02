// Shared TypeScript interfaces and types
// All source files import from here — no duplicated type definitions.

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

export enum InstitutionType {
  HIGH_SCHOOL        = 'HIGH_SCHOOL',
  COMMUNITY_COLLEGE  = 'COMMUNITY_COLLEGE',
  CHARTER            = 'CHARTER',
  ALTERNATIVE        = 'ALTERNATIVE',
}

export enum InstitutionStatus {
  ACTIVE      = 'ACTIVE',
  CLOSED      = 'CLOSED',
  MERGED_OUT  = 'MERGED_OUT',
}

export enum ResolutionMethod {
  EXACT      = 'EXACT',
  PHONETIC   = 'PHONETIC',
  FUZZY      = 'FUZZY',
  EMBEDDING  = 'EMBEDDING',
  MANUAL     = 'MANUAL',
}

export enum ResolutionStatus {
  RESOLVED     = 'RESOLVED',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  DATE_GAP     = 'DATE_GAP',
  NO_MATCH     = 'NO_MATCH',
}

// ---------------------------------------------------------------------------
// CORE DOMAIN TYPES
// These mirror the PostgreSQL schema but are typed for use in TypeScript.
// ---------------------------------------------------------------------------

export interface Institution {
  id:              string;
  institutionType: InstitutionType;
  ncesId:          string | null;
  status:          InstitutionStatus;
  createdAt:       Date;
  createdBy:       string;
}

export interface InstitutionVersion {
  id:             string;
  institutionId:  string;
  validFrom:      Date;
  validTo:        Date | null;   // null = currently active
  name:           string;
  nameNormalized: string;
  addressLine1:   string | null;
  city:           string | null;
  state:          string | null;
  zip:            string | null;
  countyFips:     string | null;
  source:         string | null;
}

export interface PartnerCrosswalk {
  id:               string;
  partnerId:        string;
  partnerKey:       string;
  institutionId:    string;
  confidence:       number;
  resolutionMethod: ResolutionMethod;
  isVerified:       boolean;
  reviewedBy:       string | null;
  reviewedAt:       Date | null;
}

// ---------------------------------------------------------------------------
// PIPELINE INPUT / OUTPUT TYPES
// ---------------------------------------------------------------------------

// Raw payload arriving from a partner — shape is unpredictable.
// Stored as-is in MongoDB before normalization.
export interface RawPartnerPayload {
  partnerId:   string;
  partnerKey:  string;
  rawName:     string;
  city?:       string;
  state?:      string;
  zip?:        string;
  sourceDate:  string;   // ISO date string from the transcript
  receivedAt:  Date;
  metadata?:   Record<string, unknown>;  // anything extra the partner sends
}

// Input to the matching pipeline after MongoDB staging
export interface MatchInput {
  partnerId:      string;
  partnerKey:     string;
  nameRaw:        string;
  nameNormalized: string;
  city:           string | null;
  state:          string | null;
  transcriptDate: Date;
}

// A candidate institution returned from the DB for comparison
export interface MatchCandidate {
  institutionId:  string;
  nameNormalized: string;
  city:           string | null;
  state:          string | null;
}

// Result of a single matching attempt
export interface MatchResult {
  institutionId:    string;
  confidence:       number;
  resolutionMethod: ResolutionMethod;
}

// Final output of resolveInstitutionAtDate()
export interface ResolutionResult {
  status:          ResolutionStatus;
  institutionId?:  string;
  nameAtDate?:     string;
  institutionType?: InstitutionType;
  confidence?:     number;
  message?:        string;   // human-readable explanation for non-RESOLVED statuses
}

// ---------------------------------------------------------------------------
// CONFIDENCE THRESHOLDS
// Centralized here so every part of the pipeline uses the same values.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  // Auto-resolve: write crosswalk, no human review needed
  AUTO_RESOLVE:       0.90,

  // Trigger embedding stage if fuzzy score is in this range
  EMBEDDING_TRIGGER:  0.75,

  // Below this: send to human review queue
  REVIEW_QUEUE:       0.60,

  // Phonetic match base confidence
  PHONETIC_BASE:      0.85,
} as const;

// ---------------------------------------------------------------------------
// MATCHING WEIGHTS
// How much each signal contributes to the final confidence score.
// Must sum to 1.0.
// ---------------------------------------------------------------------------

export const MATCH_WEIGHTS = {
  nameToken:  0.55,
  city:       0.30,
  phonetic:   0.15,
} as const;
