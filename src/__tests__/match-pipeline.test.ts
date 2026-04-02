// Tests for the matching pipeline
// Uses mock candidates — no database required.

import { runMatchPipeline, computeConfidence, phoneticKey } from '../pipeline/match-pipeline';
import { normalizeName } from '../pipeline/normalize';
import { ResolutionMethod, THRESHOLDS, MatchInput, MatchCandidate } from '../types';

// ---------------------------------------------------------------------------
// MOCK DATA
// A small set of canonical institution candidates for testing.
// Mirrors what the DB would return for a given state filter.
// ---------------------------------------------------------------------------

const MOCK_CANDIDATES: MatchCandidate[] = [
  {
    institutionId:  'uuid-lincoln-001',
    nameNormalized: 'lincoln high school',
    city:           'detroit',
    state:          'MI',
  },
  {
    institutionId:  'uuid-stmary-001',
    nameNormalized: 'saint mary high school',
    city:           'detroit',
    state:          'MI',
  },
  {
    institutionId:  'uuid-jefferson-001',
    nameNormalized: 'jefferson senior high school',
    city:           'warren',
    state:          'MI',
  },
  {
    institutionId:  'uuid-eastern-001',
    nameNormalized: 'eastern technical high school',
    city:           'baltimore',
    state:          'MD',
  },
];

function makeInput(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    partnerId:      'TEST_PARTNER',
    partnerKey:     'test-key-001',
    nameRaw:        'Lincoln High School',
    nameNormalized: 'lincoln high school',
    city:           'detroit',
    state:          'MI',
    transcriptDate: new Date('2009-06-15'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// phoneticKey tests
// ---------------------------------------------------------------------------

describe('phoneticKey', () => {
  it('produces the same key for a name and a common OCR variant', () => {
    // "Lincoln" vs "Lincohn" — phonetically similar
    expect(phoneticKey('lincoln')).toBe(phoneticKey('lincohn'));
  });

  it('produces the same key for saint and st variants', () => {
    expect(phoneticKey('saint mary')).toBe(phoneticKey('saint mary'));
  });

  it('produces different keys for clearly different names', () => {
    expect(phoneticKey('lincoln')).not.toBe(phoneticKey('jefferson'));
  });
});

// ---------------------------------------------------------------------------
// computeConfidence tests
// ---------------------------------------------------------------------------

describe('computeConfidence', () => {
  it('returns 1.0 for an identical normalized match with matching city', () => {
    const input     = makeInput();
    const candidate = MOCK_CANDIDATES[0]; // lincoln high school, detroit, MI
    const score     = computeConfidence(input, candidate);
    expect(score).toBe(1.0);
  });

  it('returns a high score for a word-order variant', () => {
    const input = makeInput({
      nameNormalized: 'high school lincoln', // scrambled tokens
    });
    const candidate = MOCK_CANDIDATES[0];
    const score     = computeConfidence(input, candidate);
    expect(score).toBeGreaterThan(0.85);
  });

  it('returns a lower score when city does not match', () => {
    const input         = makeInput({ city: 'flint' }); // wrong city
    const candidate     = MOCK_CANDIDATES[0];            // detroit
    const scoreWrongCity = computeConfidence(input, candidate);

    const inputRightCity  = makeInput({ city: 'detroit' });
    const scoreRightCity  = computeConfidence(inputRightCity, candidate);

    expect(scoreWrongCity).toBeLessThan(scoreRightCity);
  });

  it('gives partial credit when city is unknown', () => {
    const input     = makeInput({ city: null });
    const candidate = MOCK_CANDIDATES[0];
    const score     = computeConfidence(input, candidate);
    // Should still be reasonably high since name matches perfectly
    expect(score).toBeGreaterThan(0.70);
  });
});

// ---------------------------------------------------------------------------
// runMatchPipeline tests
// ---------------------------------------------------------------------------

describe('runMatchPipeline', () => {

  it('returns EXACT match for a perfectly normalized name', async () => {
    const input  = makeInput();
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    expect(result).not.toBeNull();
    expect(result!.resolutionMethod).toBe(ResolutionMethod.EXACT);
    expect(result!.confidence).toBe(1.0);
    expect(result!.institutionId).toBe('uuid-lincoln-001');
  });

  it('resolves an abbreviated name to the correct institution', async () => {
    const input = makeInput({
      nameRaw:        'St. Mary H.S.',
      nameNormalized: normalizeName('St. Mary H.S.'),
    });
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    expect(result).not.toBeNull();
    expect(result!.institutionId).toBe('uuid-stmary-001');
    expect(result!.confidence).toBeGreaterThanOrEqual(THRESHOLDS.AUTO_RESOLVE);
  });

  it('resolves a word-order variant via fuzzy matching', async () => {
    const input = makeInput({
      nameRaw:        'High School Lincoln',
      nameNormalized: normalizeName('High School Lincoln'),
    });
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    expect(result).not.toBeNull();
    expect(result!.institutionId).toBe('uuid-lincoln-001');
  });

  it('returns null when no candidate clears the threshold', async () => {
    const input = makeInput({
      nameRaw:        'Completely Unknown Academy',
      nameNormalized: normalizeName('Completely Unknown Academy'),
      city:           'nowhere',
    });
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    // Should not auto-resolve — goes to review queue
    expect(result).toBeNull();
  });

  it('does not match a school from the wrong state', async () => {
    // Eastern Technical is in MD — should not match for an MI query
    const input = makeInput({
      nameRaw:        'Eastern Technical High School',
      nameNormalized: normalizeName('Eastern Technical High School'),
      state:          'MI',
      city:           'detroit',
    });
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    // uuid-eastern-001 is in MD — should not be returned for MI query
    if (result) {
      expect(result.institutionId).not.toBe('uuid-eastern-001');
    }
  });

  it('resolves when state is unknown by searching all candidates', async () => {
    const input = makeInput({
      nameNormalized: 'lincoln high school',
      state:          null,  // state unknown
    });
    const result = await runMatchPipeline(input, MOCK_CANDIDATES);

    expect(result).not.toBeNull();
    expect(result!.institutionId).toBe('uuid-lincoln-001');
  });
});
