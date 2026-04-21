import { describe, it, expect } from 'vitest';
import {
  formatEventNote,
  formatDescriptionNote,
  isAllClearPhrase,
  matchEventFromTranscript,
  isClearAirEventType,
  getEventSpokenLabel,
} from '../eventNoteFormatter.js';

describe('formatEventNote', () => {
  it('formats single custody with no gender', () => {
    expect(formatEventNote('CUSTODY', [{ count: 1, gender: null }])).toBe('1X IN CUSTODY');
  });

  it('formats single male in custody', () => {
    expect(formatEventNote('CUSTODY', [{ count: 1, gender: 'male' }])).toBe('1X MALE IN CUSTODY');
  });

  it('formats two males in custody', () => {
    expect(formatEventNote('CUSTODY', [{ count: 2, gender: 'male' }])).toBe('2X MALE IN CUSTODY');
  });

  it('formats mixed-gender custody as comma-separated entries', () => {
    expect(
      formatEventNote('CUSTODY', [
        { count: 1, gender: 'male' },
        { count: 1, gender: 'female' },
      ])
    ).toBe('1X MALE IN CUSTODY, 1X FEMALE IN CUSTODY');
  });

  it('defaults custody count<1 to 1', () => {
    expect(formatEventNote('CUSTODY', [{ count: 0, gender: null }])).toBe('1X IN CUSTODY');
  });

  it('formats gunpoint entries', () => {
    expect(formatEventNote('GUNPOINT', [{ count: 1, gender: null }])).toBe('1X AT GUNPOINT');
    expect(formatEventNote('GUNPOINT', [{ count: 2, gender: 'male' }])).toBe('2X MALE AT GUNPOINT');
  });

  it('formats taser point and taser deployed', () => {
    expect(formatEventNote('TASER_POINT', [{ count: 1 }])).toBe('1X AT TASER POINT');
    expect(formatEventNote('TASER_DEPLOYED', [])).toBe('TASER DEPLOYED');
  });

  it('formats fighting with subject pluralization', () => {
    expect(formatEventNote('FIGHTING', [])).toBe('FIGHTING WITH SUBJECT');
    expect(formatEventNote('FIGHTING', [{ count: 1 }])).toBe('FIGHTING WITH SUBJECT');
    expect(formatEventNote('FIGHTING', [{ count: 3 }])).toBe('FIGHTING WITH 3X SUBJECTS');
  });

  it('formats pursuit and officer-needs-help labels', () => {
    expect(formatEventNote('FOOT_PURSUIT', [])).toBe('FOOT PURSUIT');
    expect(formatEventNote('VEHICLE_PURSUIT', [])).toBe('VEHICLE PURSUIT');
    expect(formatEventNote('OFFICER_NEEDS_HELP', [])).toBe('OFFICER NEEDS HELP');
  });

  it('returns null for unknown event type', () => {
    expect(formatEventNote('NOT_A_THING', [])).toBeNull();
  });
});

describe('formatDescriptionNote', () => {
  it('returns null for empty description', () => {
    expect(formatDescriptionNote('FOOT_PURSUIT', '')).toBeNull();
    expect(formatDescriptionNote('FOOT_PURSUIT', null)).toBeNull();
  });

  it('uppercases and prefixes with event label', () => {
    expect(formatDescriptionNote('FOOT_PURSUIT', 'black male, red hat'))
      .toBe('FOOT PURSUIT - DESCRIPTION: BLACK MALE, RED HAT');
  });

  it('collapses whitespace', () => {
    expect(formatDescriptionNote('VEHICLE_PURSUIT', 'red   honda    civic   plate ABC123'))
      .toBe('VEHICLE PURSUIT - DESCRIPTION: RED HONDA CIVIC PLATE ABC123');
  });
});

describe('isAllClearPhrase', () => {
  it('matches all-clear phrases', () => {
    expect(isAllClearPhrase('all clear')).toBe(true);
    expect(isAllClearPhrase('we are code 4')).toBe(true);
    expect(isAllClearPhrase("we're good")).toBe(true);
    expect(isAllClearPhrase('situation under control')).toBe(true);
    expect(isAllClearPhrase('10-22')).toBe(true);
  });

  it('does not match unrelated phrases', () => {
    expect(isAllClearPhrase('foot pursuit')).toBe(false);
    expect(isAllClearPhrase('I have one in custody')).toBe(false);
    expect(isAllClearPhrase('')).toBe(false);
    expect(isAllClearPhrase(null)).toBe(false);
  });
});

describe('isClearAirEventType', () => {
  it('returns true for non-custody emergency events', () => {
    ['GUNPOINT', 'TASER_POINT', 'TASER_DEPLOYED', 'FIGHTING', 'FOOT_PURSUIT', 'VEHICLE_PURSUIT', 'OFFICER_NEEDS_HELP']
      .forEach((t) => expect(isClearAirEventType(t)).toBe(true));
  });

  it('returns false for custody', () => {
    expect(isClearAirEventType('CUSTODY')).toBe(false);
  });
});

describe('getEventSpokenLabel', () => {
  it('returns spoken labels for known events', () => {
    expect(getEventSpokenLabel('CUSTODY')).toBe('in custody');
    expect(getEventSpokenLabel('FOOT_PURSUIT')).toBe('foot pursuit');
    expect(getEventSpokenLabel('OFFICER_NEEDS_HELP')).toBe('emergency assist');
  });
});

describe('matchEventFromTranscript', () => {
  it('matches custody phrases', () => {
    expect(matchEventFromTranscript('I have one in custody')?.eventType).toBe('CUSTODY');
    expect(matchEventFromTranscript('two males in custody')?.eventType).toBe('CUSTODY');
    expect(matchEventFromTranscript('subject in custody')?.eventType).toBe('CUSTODY');
  });

  it('extracts count and gender for custody', () => {
    const r = matchEventFromTranscript('two males in custody');
    expect(r.entries).toEqual([{ count: 2, gender: 'MALE' }]);
  });

  it('matches officer-needs-help / 10-33 / officer down', () => {
    expect(matchEventFromTranscript('officer needs help')?.eventType).toBe('OFFICER_NEEDS_HELP');
    expect(matchEventFromTranscript('10-33')?.eventType).toBe('OFFICER_NEEDS_HELP');
    expect(matchEventFromTranscript('officer down')?.eventType).toBe('OFFICER_NEEDS_HELP');
  });

  it('matches taser deployed and taser point', () => {
    expect(matchEventFromTranscript('I deployed my taser')?.eventType).toBe('TASER_DEPLOYED');
    expect(matchEventFromTranscript('one at taser point')?.eventType).toBe('TASER_POINT');
  });

  it('matches gunpoint with count', () => {
    const r = matchEventFromTranscript('two males at gunpoint');
    expect(r.eventType).toBe('GUNPOINT');
    expect(r.entries).toEqual([{ count: 2, gender: 'MALE' }]);
  });

  it('matches fighting / wrestling / struggle', () => {
    expect(matchEventFromTranscript('we are fighting')?.eventType).toBe('FIGHTING');
    expect(matchEventFromTranscript('wrestling with the subject')?.eventType).toBe('FIGHTING');
    expect(matchEventFromTranscript('in a struggle')?.eventType).toBe('FIGHTING');
  });

  it('matches vehicle pursuit', () => {
    expect(matchEventFromTranscript('vehicle pursuit')?.eventType).toBe('VEHICLE_PURSUIT');
    expect(matchEventFromTranscript('pursuing a vehicle')?.eventType).toBe('VEHICLE_PURSUIT');
  });

  it('matches foot pursuit and bare in pursuit defaults to foot', () => {
    expect(matchEventFromTranscript('foot pursuit')?.eventType).toBe('FOOT_PURSUIT');
    expect(matchEventFromTranscript("he's running")?.eventType).toBe('FOOT_PURSUIT');
    expect(matchEventFromTranscript('in pursuit')?.eventType).toBe('FOOT_PURSUIT');
  });

  it('extracts a description from foot pursuit transcript', () => {
    const r = matchEventFromTranscript('foot pursuit, black male, red hat');
    expect(r.eventType).toBe('FOOT_PURSUIT');
    expect(r.description).toMatch(/black male/i);
  });

  it('parses mixed-gender custody as separate entries', () => {
    const r = matchEventFromTranscript('one male and one female in custody');
    expect(r.eventType).toBe('CUSTODY');
    expect(r.entries.length).toBe(2);
    expect(r.entries[0]).toEqual({ count: 1, gender: 'MALE' });
    expect(r.entries[1]).toEqual({ count: 1, gender: 'FEMALE' });
  });

  it('renders count > 9 as NX', () => {
    expect(formatEventNote('CUSTODY', [{ count: 12, gender: 'MALE' }])).toBe('NX MALE IN CUSTODY');
    expect(formatEventNote('CUSTODY', [{ count: 10, gender: null }])).toBe('NX IN CUSTODY');
    expect(formatEventNote('FIGHTING', [{ count: 11 }])).toBe('FIGHTING WITH NX SUBJECTS');
  });

  it('omits unknown gender tokens', () => {
    expect(formatEventNote('CUSTODY', [{ count: 1, gender: 'unknown' }])).toBe('1X IN CUSTODY');
    expect(formatEventNote('CUSTODY', [{ count: 2, gender: 'xyz' }])).toBe('2X IN CUSTODY');
  });

  it('parses "a couple" as 2', () => {
    const r = matchEventFromTranscript('a couple in custody');
    expect(r.eventType).toBe('CUSTODY');
    expect(r.entries[0].count).toBe(2);
    expect(formatEventNote(r.eventType, r.entries)).toBe('2X IN CUSTODY');
  });

  it('captures descriptors for non-pursuit events', () => {
    const r = matchEventFromTranscript('one male in custody, black hoodie, blue jeans');
    expect(r.eventType).toBe('CUSTODY');
    expect(r.description).toMatch(/black hoodie/i);
  });

  it('returns null for unrelated transcripts', () => {
    expect(matchEventFromTranscript('radio check')).toBeNull();
    expect(matchEventFromTranscript('')).toBeNull();
  });
});
