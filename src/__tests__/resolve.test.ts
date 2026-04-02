// Tests for resolveInstitutionAtDate
// Uses a fully mocked ResolutionDb — no real database required.
// Tests cover the four possible resolution outcomes:
//   RESOLVED, NEEDS_REVIEW, DATE_GAP, and crosswalk cache hit.

import { resolveInstitutionAtDate, ResolutionDb } from '../pipeline/resolve';
import {
  ResolutionStatus,
  ResolutionMethod,
  InstitutionType,
  InstitutionStatus,
  PartnerCrosswalk,
  InstitutionVersion,
  MatchCandidate,
  MatchInput,
} from '../types';

// ---------------------------------------------------------------------------
// MOCK DATA
// ---------------------------------------------------------------------------

const MOCK_INSTITUTION_ID = 'uuid-lincoln-001';

const MOCK_VERSION_2005: InstitutionVersion = {
  id:             'ver-001',
  institutionId:  MOCK_INSTITUTION_ID,
  validFrom:      new Date('2005-08-01'),
  validTo:        null,  // currently active
  name:           'Lincoln STEM Academy',
  nameNormalized: 'lincoln stem academy',
  addressLine1:   '1234 Main St',
  city:           'Detroit',
  state:          'MI',
  zip:            '48201',
  countyFips:     '26163',
  source:         'NCES',
};

const MOCK_VERSION_1992: InstitutionVersion = {
  id:             'ver-000',
  institutionId:  MOCK_INSTITUTION_ID,
  validFrom:      new Date('1992-09-01'),
  validTo:        new Date('2005-07-31'),
  name:           'Lincoln High School',
  nameNormalized: 'lincoln high school',
  addressLine1:   '1234 Main St',
  city:           'Detroit',
  state:          'MI',
  zip:            '48201',
  countyFips:     '26163',
  source:         'NCES',
};

const MOCK_CANDIDATES: MatchCandidate[] = [
  {
    institutionId:  MOCK_INSTITUTION_ID,
    nameNormalized: 'lincoln high school',
    city:           'detroit',
    state:          'MI',
  },
  {
    institutionId:  MOCK_INSTITUTION_ID,
    nameNormalized: 'lincoln stem academy',
    city:           'detroit',
    state:          'MI',
  },
];

// ---------------------------------------------------------------------------
// MOCK DB FACTORY
// Returns a mock ResolutionDb with controllable responses.
// Override individual methods per test as needed.
// ---------------------------------------------------------------------------

function makeMockDb(overrides: Partial<ResolutionDb> = {}): ResolutionDb {
  return {
    findCrosswalk:        jest.fn().mockResolvedValue(null),
    findVersionAtDate:    jest.fn().mockResolvedValue(MOCK_VERSION_2005),
    findCandidatesByState: jest.fn().mockResolvedValue(MOCK_CANDIDATES),
    findAllCandidates:    jest.fn().mockResolvedValue(MOCK_CANDIDATES),
    upsertCrosswalk:      jest.fn().mockResolvedValue(undefined),
    enqueueForReview:     jest.fn().mockResolvedValue(undefined),
    findInstitution:      jest.fn().mockResolvedValue({
      institutionType: InstitutionType.HIGH_SCHOOL,
      status:          InstitutionStatus.ACTIVE,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('resolveInstitutionAtDate', () => {

  describe('crosswalk cache hit', () => {
    it('returns RESOLVED using cached crosswalk without running matching', async () => {
      const cachedCrosswalk: PartnerCrosswalk = {
        id:               'xwalk-001',
        partnerId:        'NAVIANCE',
        partnerKey:       'nav-lincoln-001',
        institutionId:    MOCK_INSTITUTION_ID,
        confidence:       1.0,
        resolutionMethod: ResolutionMethod.EXACT,
        isVerified:       true,
        reviewedBy:       null,
        reviewedAt:       null,
      };

      const db = makeMockDb({
        findCrosswalk: jest.fn().mockResolvedValue(cachedCrosswalk),
      });

      const result = await resolveInstitutionAtDate(
        'NAVIANCE', 'nav-lincoln-001',
        'Lincoln HS', 'Detroit', 'MI',
        new Date('2010-03-15'),
        db
      );

      expect(result.status).toBe(ResolutionStatus.RESOLVED);
      expect(result.institutionId).toBe(MOCK_INSTITUTION_ID);
      // Matching pipeline should NOT have been called
      expect(db.findCandidatesByState).not.toHaveBeenCalled();
    });
  });

  describe('bitemporal resolution — correct name at date', () => {
    it('returns the name as it was BEFORE the 2005 rename for a 2003 transcript', async () => {
      const db = makeMockDb({
        findVersionAtDate: jest.fn().mockResolvedValue(MOCK_VERSION_1992),
      });

      const result = await resolveInstitutionAtDate(
        'COMMON_APP', 'ca-lincoln-001',
        'Lincoln High School', 'Detroit', 'MI',
        new Date('2003-06-15'),  // transcript issued before the rename
        db
      );

      expect(result.status).toBe(ResolutionStatus.RESOLVED);
      expect(result.nameAtDate).toBe('Lincoln High School');  // pre-rename name
      expect(result.institutionId).toBe(MOCK_INSTITUTION_ID); // same ID
    });

    it('returns the renamed name for a 2009 transcript', async () => {
      const db = makeMockDb({
        findVersionAtDate: jest.fn().mockResolvedValue(MOCK_VERSION_2005),
      });

      const result = await resolveInstitutionAtDate(
        'COMMON_APP', 'ca-lincoln-002',
        'Lincoln STEM Academy', 'Detroit', 'MI',
        new Date('2009-06-15'),  // transcript issued after the rename
        db
      );

      expect(result.status).toBe(ResolutionStatus.RESOLVED);
      expect(result.nameAtDate).toBe('Lincoln STEM Academy'); // post-rename name
      expect(result.institutionId).toBe(MOCK_INSTITUTION_ID); // same stable ID
    });
  });

  describe('no match found', () => {
    it('returns NEEDS_REVIEW when no candidate clears the threshold', async () => {
      const db = makeMockDb({
        findCandidatesByState: jest.fn().mockResolvedValue([]),
        findAllCandidates:     jest.fn().mockResolvedValue([]),
      });

      const result = await resolveInstitutionAtDate(
        'NAVIANCE', 'nav-unknown-999',
        'Completely Unknown Academy XYZ', 'Nowhere', 'MI',
        new Date('2009-06-15'),
        db
      );

      expect(result.status).toBe(ResolutionStatus.NEEDS_REVIEW);
      expect(db.enqueueForReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('date gap', () => {
    it('returns DATE_GAP when institution exists but no version covers the transcript date', async () => {
      const db = makeMockDb({
        // Institution is found via matching, but no version exists for this date
        findVersionAtDate: jest.fn().mockResolvedValue(null),
      });

      const result = await resolveInstitutionAtDate(
        'NAVIANCE', 'nav-lincoln-001',
        'Lincoln High School', 'Detroit', 'MI',
        new Date('1985-06-15'),  // before the school opened
        db
      );

      expect(result.status).toBe(ResolutionStatus.DATE_GAP);
      expect(result.institutionId).toBe(MOCK_INSTITUTION_ID);
      expect(result.message).toContain('1985');
    });
  });

  describe('crosswalk is written after a successful match', () => {
    it('calls upsertCrosswalk after resolving via matching pipeline', async () => {
      const db = makeMockDb();

      await resolveInstitutionAtDate(
        'NAVIANCE', 'nav-lincoln-new',
        'Lincoln High School', 'Detroit', 'MI',
        new Date('2009-06-15'),
        db
      );

      expect(db.upsertCrosswalk).toHaveBeenCalledTimes(1);
      expect(db.upsertCrosswalk).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId:     'NAVIANCE',
          partnerKey:    'nav-lincoln-new',
          institutionId: MOCK_INSTITUTION_ID,
        })
      );
    });
  });

  describe('institution type classification', () => {
    it('returns HIGH_SCHOOL institution type in the resolved result', async () => {
      const db = makeMockDb();

      const result = await resolveInstitutionAtDate(
        'NAVIANCE', 'nav-lincoln-001',
        'Lincoln High School', 'Detroit', 'MI',
        new Date('2009-06-15'),
        db
      );

      expect(result.institutionType).toBe(InstitutionType.HIGH_SCHOOL);
    });
  });
});
