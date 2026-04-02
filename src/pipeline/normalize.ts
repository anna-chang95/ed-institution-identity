// Name normalization
// Converts a raw school name (from a transcript or partner payload) into
// a normalized form suitable for matching against canonical records.
//
// This is a pure function module — no database calls, no side effects.
// Every function here is fully testable without any infrastructure.

// ---------------------------------------------------------------------------
// ABBREVIATION MAP
// Maps common abbreviations to their full forms.
// Keys are regex patterns (case-insensitive).
// Order matters — more specific patterns should come before general ones.
// ---------------------------------------------------------------------------

const ABBREVIATION_MAP: Array<[RegExp, string]> = [
  // School type abbreviations
  [/\bh\.?s\.?\b/gi,        'high school'],
  [/\belem\.?\b/gi,         'elementary'],
  [/\bjr\.?\s*h\.?s\.?\b/gi,'junior high school'],
  [/\bsr\.?\s*h\.?s\.?\b/gi,'senior high school'],
  [/\bacad\.?\b/gi,         'academy'],
  [/\bprep\.?\b/gi,         'preparatory'],
  [/\btech\.?\b/gi,         'technical'],
  [/\bvoc\.?\b/gi,          'vocational'],
  [/\bcomm\.?\b/gi,         'community'],
  [/\bintl\.?\b/gi,         'international'],
  [/\bmem\.?\b/gi,          'memorial'],
  [/\bmag\.?\b/gi,          'magnet'],
  [/\balt\.?\b/gi,          'alternative'],
  [/\bchtr\.?\b/gi,         'charter'],

  // Name prefix abbreviations
  [/\bst\.?\b/gi,           'saint'],
  [/\bmt\.?\b/gi,           'mount'],
  [/\bft\.?\b/gi,           'fort'],

  // Directional abbreviations
  [/\bn\.?\b/gi,            'north'],
  [/\bs\.?\b/gi,            'south'],
  [/\be\.?\b/gi,            'east'],
  [/\bw\.?\b/gi,            'west'],

  // Common word abbreviations
  [/\bjr\.?\b/gi,           'junior'],
  [/\bsr\.?\b/gi,           'senior'],
  [/\bdr\.?\b/gi,           'drive'],
  [/\bavg?\.?\b/gi,         'avenue'],
  [/\bblvd\.?\b/gi,         'boulevard'],
];

// ---------------------------------------------------------------------------
// OCR CORRECTION MAP
// Common character substitutions introduced by OCR scanning.
// Only applied when the source is flagged as OCR-derived.
// ---------------------------------------------------------------------------

const OCR_CORRECTIONS: Array<[RegExp, string]> = [
  [/\b0([a-z])/gi, 'o$1'],  // 0 → O at word start before letters
  [/([a-z])0\b/gi, '$1o'],  // 0 → O at word end after letters
  [/\brn\b/gi,     'm'],    // rn → m (very common OCR error)
  [/\bI([a-z])/g,  'l$1'],  // I → l before lowercase (Iincoln → lincoln)
  [/\b1([a-z])/gi, 'l$1'],  // 1 → l at word start before letters
];

// ---------------------------------------------------------------------------
// normalizeName
// Main export. Converts a raw name to a normalized, matchable string.
//
// Steps:
//   1. Lowercase
//   2. Apply OCR corrections (if isOcr flag is set)
//   3. Expand abbreviations
//   4. Strip punctuation
//   5. Collapse whitespace
// ---------------------------------------------------------------------------

export function normalizeName(
  raw:   string,
  isOcr: boolean = false
): string {
  let s = raw.toLowerCase().trim();

  // Step 1: OCR corrections (before abbreviation expansion)
  if (isOcr) {
    for (const [pattern, replacement] of OCR_CORRECTIONS) {
      s = s.replace(pattern, replacement);
    }
  }

  // Step 2: Expand abbreviations
  for (const [pattern, replacement] of ABBREVIATION_MAP) {
    s = s.replace(pattern, replacement);
  }

  // Step 3: Strip punctuation (preserve internal hyphens in names like "Winston-Salem")
  s = s.replace(/[^\w\s-]/g, ' ');

  // Step 4: Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ---------------------------------------------------------------------------
// normalizeState
// Ensures state is a clean 2-letter uppercase code.
// Handles inputs like "michigan", "Mich.", "MI".
// ---------------------------------------------------------------------------

const STATE_NAME_MAP: Record<string, string> = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

export function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const cleaned = raw.trim().toLowerCase().replace(/\./g, '');

  // Already a 2-letter code
  if (/^[a-z]{2}$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return STATE_NAME_MAP[cleaned] ?? null;
}

// ---------------------------------------------------------------------------
// normalizeCity
// Simple city normalization — lowercase and trim.
// ---------------------------------------------------------------------------

export function normalizeCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.toLowerCase().trim().replace(/\s+/g, ' ');
}
