import { describe, it, expect } from 'vitest';
import {
  matchSecureConfirmation,
  matchWelfarePositive,
  matchGenericAffirmation,
  matchFloorHandoff,
} from '../commandMatcher.js';

describe('Task #559: typed matchers', () => {
  describe('matchFloorHandoff', () => {
    it('returns handoff for "go ahead" / "send it" / "send your traffic" / "go"', () => {
      for (const phrase of ['go ahead', 'send it', 'send your traffic', 'send your message', 'go']) {
        const m = matchFloorHandoff(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ handoff: true, matchedList: 'floor_handoff' }));
      }
    });
    it('does not match welfare or affirmation phrases', () => {
      for (const phrase of ['10-4', "i'm okay", 'copy', 'roger', 'yes', 'no']) {
        expect(matchFloorHandoff(phrase), `phrase=${phrase}`).toBeNull();
      }
    });
    it('does not match "north", "noise", "going home" — not floor handoff', () => {
      expect(matchFloorHandoff('going home')).toBeNull();
      expect(matchFloorHandoff('northbound')).toBeNull();
      expect(matchFloorHandoff('I am going to the scene')).toBeNull();
    });
  });

  describe('matchWelfarePositive', () => {
    it('returns welfare for explicit phrases', () => {
      for (const phrase of [
        '10-4', 'ten four', 'ten-four', "i'm 10-4", "i'm okay", 'im okay',
        'all good', 'all clear', 'code 4', 'code four', "i'm good", 'i am fine',
      ]) {
        const m = matchWelfarePositive(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ welfare: true }));
      }
    });
    it('does NOT match generic affirmations / floor handoff / unrelated speech', () => {
      for (const phrase of ['copy', 'roger', 'yes', 'affirmative', 'go ahead', 'send it', 'i am en route']) {
        expect(matchWelfarePositive(phrase), `phrase=${phrase}`).toBeNull();
      }
    });
    it('returns null when transcript also contains a deny phrase (e.g. "no, 10-4")', () => {
      for (const phrase of ['no, 10-4', 'no 10-4', 'negative, ten four', 'no copy', 'no, all good']) {
        expect(matchWelfarePositive(phrase), `phrase=${phrase}`).toBeNull();
      }
    });
  });

  describe('matchGenericAffirmation', () => {
    it('returns affirm for "yes" / "yeah" / "copy" / "roger" / "affirmative"', () => {
      for (const phrase of ['yes', 'yeah', 'copy', 'roger', 'affirmative', 'secure']) {
        const m = matchGenericAffirmation(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ affirm: true }));
      }
    });
    it('does NOT match welfare phrases', () => {
      for (const phrase of ['10-4', "i'm okay", 'all good']) {
        expect(matchGenericAffirmation(phrase), `phrase=${phrase}`).toBeNull();
      }
    });
    it('returns null when transcript contains a deny phrase', () => {
      expect(matchGenericAffirmation('no, copy')).toBeNull();
      expect(matchGenericAffirmation('negative, affirmative')).toBeNull();
    });
  });

  describe('matchSecureConfirmation: deny-before-confirm precedence', () => {
    it('classifies "no" / "negative" / "no go" / "no copy" as deny', () => {
      for (const phrase of ['no', 'negative', 'no go', 'no copy', 'standby', 'hold', 'not secure']) {
        const m = matchSecureConfirmation(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ confirmed: false, matchedList: 'deny' }));
      }
    });
    it('classifies overlap transcripts as deny ("no, copy" / "no 10-4" / "negative, affirmative")', () => {
      for (const phrase of [
        'no, copy', 'no copy', 'no 10-4', 'no, 10-4',
        'negative, affirmative', 'negative copy', 'no, hold on', 'no, affirmative',
      ]) {
        const m = matchSecureConfirmation(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ confirmed: false }));
      }
    });
    it('classifies pure positives as confirm', () => {
      for (const phrase of ['yes', 'yeah', 'affirmative', 'copy', 'roger', 'secure', '10-4', 'ten four']) {
        const m = matchSecureConfirmation(phrase);
        expect(m, `phrase=${phrase}`).toEqual(expect.objectContaining({ confirmed: true, matchedList: 'confirm' }));
      }
    });
    it('does NOT classify "go ahead" as confirm (floor handoff is its own intent)', () => {
      // Bare "go ahead" — should not be confirm. The whole transcript is just
      // a floor handoff; matchSecureConfirmation should not treat it as a
      // welfare ack or even a generic mic-secure confirmation.
      expect(matchSecureConfirmation('go ahead')).toBeNull();
    });
    it('does NOT match "no" as substring of "north" / "northbound" / "noise"', () => {
      for (const phrase of ['northbound', 'noise on the channel', 'going north']) {
        const m = matchSecureConfirmation(phrase);
        // None of these contain a real "no" word — should not deny.
        expect(m?.confirmed, `phrase=${phrase}`).not.toBe(false);
      }
    });
  });
});
