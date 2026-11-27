import { GALLONS_PROBLEM, isReading, parseReading, READING_MAX, READING_PROBLEM } from '../reading';

// A reading typed into a number box: equipment hours, an odometer, gallons of fuel. On Android the number
// pad is whatever the keyboard shows, and nothing filters it (React Native's own key listener lets every key
// through), so a minus sign, a space or a comma can reach the box. The rule is here, so every screen and the
// store read a typed reading the same way.
describe('a reading as typed', () => {
  it('reads a number with a comma between thousands, and spaces at the ends', () => {
    expect(parseReading('1,000')).toBe(1000);
    expect(parseReading(' 4,250.5 ')).toBe(4250.5);
    expect(parseReading('0')).toBe(0);
    expect(parseReading('.5')).toBe(0.5);
    expect(parseReading('12.')).toBe(12);
  });

  it('takes a comma only between thousands, so a comma for a decimal point is asked again, not read ten times over', () => {
    // A phone set to a region that writes 12,5 for twelve and a half has a comma on its decimal pad. Read as
    // 125, that would go on the signed card and into the safety log; it is turned back instead.
    expect(parseReading('1,000')).toBe(1000);
    expect(parseReading('1,000.5')).toBe(1000.5);
    expect(parseReading('10,000,000')).toBe(10_000_000);
    expect(parseReading('1,000.')).toBe(1000);
    for (const typed of ['12,5', '1,00', '0,5', '4250,5', '1,0000', ',5', '1,', '1,,000', '1,000,', '1,000.5,0', '1.000,5', ',']) {
      expect({ typed, read: parseReading(typed) }).toEqual({ typed, read: Number.NaN });
    }
  });

  it('is nothing when nothing is typed', () => {
    expect(parseReading('')).toBeUndefined();
    expect(parseReading('   ')).toBeUndefined();
  });

  it('is not a reading with a minus sign, a space between digits, a letter, two points or more than a meter shows', () => {
    // A space between digits is asked about again, not guessed at: 12 000 could be 12000, and 12 5 a slip for 12.5.
    for (const typed of ['-5', '-12', '\u221212', '5-', '12 000', '12 5', '61\u00a0200', 'abc', '12 hrs', '1e9', '4.2.1', '.', '+3', 'NaN', 'Infinity', String(READING_MAX + 1)]) {
      expect({ typed, read: parseReading(typed) }).toEqual({ typed, read: Number.NaN });
    }
    expect(parseReading(String(READING_MAX))).toBe(READING_MAX);
  });

  it('holds a number that is not typed to the same rule', () => {
    expect([0, 0.5, 4250.5, READING_MAX].every(isReading)).toBe(true);
    expect([-0.1, -12, Number.NaN, Number.POSITIVE_INFINITY, READING_MAX + 1].some(isReading)).toBe(false);
  });

  it('is what the company takes for a unit, so a reading the phone has is always one it can show again', () => {
    // readRecord (receive.ts) and the server take a unit's reading from 0 to 10,000,000.
    expect(READING_MAX).toBe(10_000_000);
  });

  it('says what to put right', () => {
    // Each shows a point for a part, so someone who typed 12,5 sees how to type it.
    expect(READING_PROBLEM).toBe('Enter the reading off the machine as a number, like 4250.5.');
    expect(GALLONS_PROBLEM).toBe('Enter the gallons added as a number, like 12.5, or leave it blank.');
  });
});

// Every screen that takes a reading reads it with this rule, so a minus sign is turned back the same way
// everywhere, and none drops what it cannot read without a word.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));
const source = (file: string) => fs.readFileSync(`${root}/src/${file}`, 'utf8');

describe('the screens that take a reading', () => {
  it('read it with parseReading or readMeter, never with Number() alone', () => {
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx', 'screens/supervisor/FleetScreen.tsx']) {
      const text = source(file);
      expect({ file, reads: /\b(parseReading|readMeter)\(/.test(text) }).toEqual({ file, reads: true });
      expect({ file, number: text.match(/Number\((meter|fuel|gallons)\b[^)]*\)/g) }).toEqual({ file, number: null });
    }
  });

  it('say what is wrong with one in the same words, which show a point for a part', () => {
    // A comma typed for a point (12,5) is turned back with these, so the person sees 12.5 and types that.
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx']) {
      expect({ file, reading: /\bREADING_PROBLEM\b/.test(source(file)) }).toEqual({ file, reading: true });
    }
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx']) {
      expect({ file, gallons: /\bGALLONS_PROBLEM\b/.test(source(file)) }).toEqual({ file, gallons: true });
    }
  });
});
