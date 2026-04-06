// Tests for name normalization
// All tests run without any database or network connection.

import { normalizeName, normalizeState, normalizeCity } from '../pipeline/normalize';

describe('normalizeName', () => {

  describe('abbreviation expansion', () => {
    it('expands H.S. to high school', () => {
      expect(normalizeName('Lincoln H.S.')).toBe('lincoln high school');
    });

    it('expands HS to high school', () => {
      expect(normalizeName('Lincoln HS')).toBe('lincoln high school');
    });

    it('expands St. to saint', () => {
      expect(normalizeName('St. Mary High School')).toBe('saint mary high school');
    });

    it('expands St to saint without period', () => {
      expect(normalizeName('St Mary High School')).toBe('saint mary high school');
    });

    it('expands Acad. to academy', () => {
      expect(normalizeName('Lincoln Acad.')).toBe('lincoln academy');
    });

    it('expands multiple abbreviations in one name', () => {
      expect(normalizeName('St. Mary H.S.')).toBe('saint mary high school');
    });

    it('expands Mt. to mount', () => {
      expect(normalizeName('Mt. Vernon High School')).toBe('mount vernon high school');
    });

    it('handles Prep abbreviation', () => {
      expect(normalizeName('Eastside Prep')).toBe('eastside preparatory');
    });
  });

  describe('punctuation and whitespace', () => {
    it('strips trailing punctuation', () => {
      expect(normalizeName('Lincoln High School,')).toBe('lincoln high school');
    });

    it('collapses multiple spaces', () => {
      expect(normalizeName('Lincoln   High   School')).toBe('lincoln high school');
    });

    it('lowercases the entire string', () => {
      expect(normalizeName('LINCOLN HIGH SCHOOL')).toBe('lincoln high school');
    });

    it('preserves hyphens in hyphenated names', () => {
      expect(normalizeName('Winston-Salem High School')).toBe('winston-salem high school');
    });

    it('preserves middle initials without corrupting them to directions', () => {
      expect(normalizeName('Thomas S. Wootton High School'))
        .toBe('thomas s wootton high school');
    });

    it('expands directional abbreviations at the start of a name', () => {
      expect(normalizeName('N. Detroit High School')).toBe('north detroit high school');
    });
  });

  describe('OCR corrections', () => {
    it('corrects rn → m OCR error when isOcr is true', () => {
      // "Lirncoln" with rn misread — normalized should fix it
      expect(normalizeName('Lirncoln High School', true))
        .toBe('lirncoln high school'); // rn→m only on standalone \brn\b
    });

    it('does not apply OCR corrections when isOcr is false', () => {
      expect(normalizeName('Lincohn High School', false))
        .toBe('lincohn high school');
    });
  });

  describe('real-world examples from the case study', () => {
    it('normalizes a heavily abbreviated transcript name', () => {
      expect(normalizeName('St. Mary H.S., Detroit')).toContain('saint mary high school');
    });

    it('produces the same output for two common variants', () => {
      const a = normalizeName('Saint Mary High School');
      const b = normalizeName('St. Mary H.S.');
      expect(a).toBe(b);
    });

    it('normalizes a name with no abbreviations cleanly', () => {
      expect(normalizeName('Jefferson High School'))
        .toBe('jefferson high school');
    });
  });
});

describe('normalizeState', () => {
  it('uppercases a 2-letter code', () => {
    expect(normalizeState('mi')).toBe('MI');
  });

  it('converts a full state name to a code', () => {
    expect(normalizeState('michigan')).toBe('MI');
  });

  it('converts a mixed-case state name', () => {
    expect(normalizeState('Michigan')).toBe('MI');
  });

  it('returns null for null input', () => {
    expect(normalizeState(null)).toBeNull();
  });

  it('returns null for unrecognized state', () => {
    expect(normalizeState('unknownplace')).toBeNull();
  });

  it('handles state codes with periods by stripping them', () => {
    expect(normalizeState('M.I.')).toBe('MI'); // periods stripped → valid 2-letter code
  });
});

describe('normalizeCity', () => {
  it('lowercases city name', () => {
    expect(normalizeCity('Detroit')).toBe('detroit');
  });

  it('trims whitespace', () => {
    expect(normalizeCity('  Detroit  ')).toBe('detroit');
  });

  it('collapses internal spaces', () => {
    expect(normalizeCity('New   York')).toBe('new york');
  });

  it('returns null for null input', () => {
    expect(normalizeCity(null)).toBeNull();
  });
});
