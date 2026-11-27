import { fmtMeter } from '../../util/format';
import {
  gallonsProblem, isReading, leaveHoursProblem, meterText, parseDecimal, parseDollars, parseReading, rateProblem, READING_MAX,
  readingProblem, readingText, timeSpentProblem, withMark, type DecimalMark,
} from '../reading';

// A reading typed into a number box: equipment hours, an odometer, gallons of fuel. On Android the number
// pad is whatever the keyboard shows, and nothing filters it (React Native's own key listener lets every key
// through), so a minus sign, a space or a comma can reach the box. The iPhone's decimal pad has digits and
// the phone's own decimal mark: a point, or a comma on a phone set to a region that writes 12,5 for twelve
// and a half. The rule is here, so every screen and the store read a typed reading the same way, by the
// phone's mark.
const nan = (mark: DecimalMark, typed: string[]) => {
  for (const t of typed) expect({ mark, typed: t, read: parseReading(t, mark) }).toEqual({ mark, typed: t, read: Number.NaN });
};

describe('a reading as typed on a phone that writes a point for a part', () => {
  it('reads a number with a comma between thousands, and spaces at the ends', () => {
    expect(parseReading('1,000')).toBe(1000);
    expect(parseReading(' 4,250.5 ')).toBe(4250.5);
    expect(parseReading('0')).toBe(0);
    expect(parseReading('.5')).toBe(0.5);
    expect(parseReading('12.')).toBe(12);
  });

  it('is the rule with no mark given', () => {
    for (const typed of ['1,000', '4250.5', '12,5', '', '-5']) expect(parseReading(typed, '.')).toEqual(parseReading(typed));
  });

  it('takes a comma only between thousands, so a comma for a decimal point is asked again, not read ten times over', () => {
    // Read as 125, 12,5 would go on the signed card and into the safety log; it is turned back instead.
    expect(parseReading('1,000')).toBe(1000);
    expect(parseReading('1,000.5')).toBe(1000.5);
    expect(parseReading('10,000,000')).toBe(10_000_000);
    expect(parseReading('1,000.')).toBe(1000);
    nan('.', ['12,5', '1,00', '0,5', '4250,5', '1,0000', ',5', '1,', '1,,000', '1,000,', '1,000.5,0', '1.000,5', ',']);
  });

  it('is nothing when nothing is typed', () => {
    expect(parseReading('')).toBeUndefined();
    expect(parseReading('   ')).toBeUndefined();
  });

  it('is not a reading with a minus sign, a space between digits, a letter, two points or more than a meter shows', () => {
    // A space between digits is asked about again, not guessed at: 12 000 could be 12000, and 12 5 a slip for 12.5.
    nan('.', ['-5', '-12', '−12', '5-', '12 000', '12 5', '61 200', 'abc', '12 hrs', '1e9', '4.2.1', '.', '+3', 'NaN', 'Infinity', String(READING_MAX + 1)]);
    expect(parseReading(String(READING_MAX))).toBe(READING_MAX);
  });
});

describe('a reading as typed on a phone that writes a comma for a part', () => {
  it('reads a single comma followed by digits as the decimal point', () => {
    // The iPhone's decimal pad in such a region has a comma and no point: 4250,5 is all it can type.
    expect(parseReading('4250,5', ',')).toBe(4250.5);
    expect(parseReading(' 12,5 ', ',')).toBe(12.5);
    expect(parseReading('0,5', ',')).toBe(0.5);
    expect(parseReading(',5', ',')).toBe(0.5);
    expect(parseReading('4250', ',')).toBe(4250);
    expect(parseReading('0', ',')).toBe(0);
    // Where the comma is the decimal point, 1,000 is one, as the person who typed it reads it.
    expect(parseReading('1,000', ',')).toBe(1);
  });

  it('takes a point or a space between thousands only where it groups threes', () => {
    expect(parseReading('1.000,5', ',')).toBe(1000.5);
    expect(parseReading('1.000', ',')).toBe(1000);
    expect(parseReading('10.000.000', ',')).toBe(10_000_000);
    expect(parseReading('10 000', ',')).toBe(10_000);
    expect(parseReading('1 000,5', ',')).toBe(1000.5);
    // The spaces such a phone writes between thousands: a no-break space, and the narrow one.
    expect(parseReading('61 200', ',')).toBe(61_200);
    expect(parseReading('1 000,5', ',')).toBe(1000.5);
  });

  it('still reads a lone point followed by digits that do not group threes as the decimal point', () => {
    // An Android number pad may have both keys, and a prefilled reading the phone wrote before may have a point.
    expect(parseReading('12.5', ',')).toBe(12.5);
    expect(parseReading('4250.5', ',')).toBe(4250.5);
    expect(parseReading('1.50', ',')).toBe(1.5);
    expect(parseReading('.5', ',')).toBe(0.5);
    // No thousand starts with a nought, and no group of thousands has four figures ahead of it.
    expect(parseReading('0.500', ',')).toBe(0.5);
    expect(parseReading('1234.567', ',')).toBe(1234.567);
  });

  it('is nothing when nothing is typed', () => {
    expect(parseReading('', ',')).toBeUndefined();
    expect(parseReading('  ', ',')).toBeUndefined();
  });

  it('turns back anything else, so a reading is asked again, not guessed', () => {
    nan(',', [
      // A comma with nothing after it, two commas, or a point mixed in where it is not between thousands.
      '12,', ',', '1,,5', '1,5,5', '1.000,', '1.00,5', '12.5,3', '1,000.5', '1 000,',
      // A space or a point that does not group threes, or groups them with two marks.
      '12 5', '1 00', '1.00.000', '4.2.1', '1.000 000', '12.', '.', '1.0000,5',
      // A sign, an exponent, a letter, or more than a meter shows.
      '-5', '−12', '+3', '1e9', 'abc', '12 hrs', 'NaN', 'Infinity', '10.000.001', '10000000,5',
    ]);
  });
});

describe('a reading written into a box for the phone to read again', () => {
  it('is written with the phone’s own mark, and nothing between thousands', () => {
    expect(readingText(4250.5)).toBe('4250.5');
    expect(readingText(4250.5, ',')).toBe('4250,5');
    expect(readingText(100.125, ',')).toBe('100,125');
    expect(readingText(61_200, ',')).toBe('61200');
  });

  it('reads back as the same reading in either region', () => {
    // Written with a point, 100.125 on a comma phone would read as 100125 hours: the mark keeps it the same.
    for (const mark of ['.', ','] as const) {
      for (const n of [0, 0.5, 12.5, 100.125, 999.999, 1234.567, 4250.5, 61_200, READING_MAX]) {
        expect({ mark, n, read: parseReading(readingText(n, mark), mark) }).toEqual({ mark, n, read: n });
      }
    }
  });
});

describe('a number that is not typed', () => {
  it('is held to the same rule', () => {
    expect([0, 0.5, 4250.5, READING_MAX].every((n) => isReading(n))).toBe(true);
    expect([-0.1, -12, Number.NaN, Number.POSITIVE_INFINITY, READING_MAX + 1].some((n) => isReading(n))).toBe(false);
  });

  it('is what the company takes for a unit, so a reading the phone has is always one it can show again', () => {
    // readRecord (receive.ts) and the server take a unit's reading from 0 to 10,000,000.
    expect(READING_MAX).toBe(10_000_000);
  });
});

describe('what to put right', () => {
  it('shows a part with the phone’s own mark, so the example is one its keyboard can type', () => {
    expect(readingProblem()).toBe('Enter the reading off the machine as a number, like 4250.5.');
    expect(gallonsProblem()).toBe('Enter the gallons added as a number, like 12.5, or leave it blank.');
    expect(readingProblem(',')).toBe('Enter the reading off the machine as a number, like 4250,5.');
    expect(gallonsProblem(',')).toBe('Enter the gallons added as a number, like 12,5, or leave it blank.');
  });

  it('gives an example that reads as a reading in its own region', () => {
    for (const mark of ['.', ','] as const) {
      expect(parseReading(`4250${mark}5`, mark)).toBe(4250.5);
      expect(parseReading(`12${mark}5`, mark)).toBe(12.5);
    }
  });
});

describe('any other number typed into a box with a decimal pad', () => {
  // Hours of paid leave, the time spent on a maintenance request, an hourly rate: the same keyboard, the same
  // mark, so the same rule as a reading, and each box keeps its own range.
  it('is read by the same rule as a reading, by the phone’s mark', () => {
    for (const mark of ['.', ','] as const) {
      for (const typed of ['', '  ', '4,5', '4.5', '1,000', '1.000,5', '10 000', '12,5,0', '-5', '1e3', 'abc', '8,00', '8.00', '0,25', '.5', ',5']) {
        expect({ mark, typed, read: parseDecimal(typed, mark) }).toEqual({ mark, typed, read: parseReading(typed, mark) });
      }
    }
  });

  it('reads 4,5 as four and a half where the phone writes a comma, and asks again where it writes a point', () => {
    expect(parseDecimal('4,5', ',')).toBe(4.5);
    expect(parseDecimal('9,75', ',')).toBe(9.75);
    expect(parseDecimal('8,00', ',')).toBe(8);
    expect(parseDecimal('4.5')).toBe(4.5);
    expect(parseDecimal('4,5')).toBeNaN();
    expect(parseDecimal('9,75')).toBeNaN();
  });

  it('has no range of its own: a box keeps its own', () => {
    expect(parseDecimal(String(READING_MAX * 2))).toBe(READING_MAX * 2);
    expect(parseReading(String(READING_MAX * 2))).toBeNaN();
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal('9'.repeat(400))).toBeNaN();
  });

  it('is nothing when nothing is typed, and not a number with a sign, an exponent or a letter', () => {
    expect(parseDecimal('')).toBeUndefined();
    expect(parseDecimal(' ', ',')).toBeUndefined();
    nanDecimal(['-4', '+4', '1e1', '0x10', '4 hrs', 'Infinity']);
  });
});

function nanDecimal(typed: string[]) {
  for (const mark of ['.', ','] as const) {
    for (const t of typed) expect({ mark, typed: t, read: parseDecimal(t, mark) }).toEqual({ mark, typed: t, read: Number.NaN });
  }
}

describe('dollars typed into the hourly rate', () => {
  it('reads 9,75 as nine dollars and seventy-five cents where the phone writes a comma, never 975', () => {
    expect(parseDollars('9,75', ',')).toBe(9.75);
    expect(parseDollars('24,50', ',')).toBe(24.5);
    expect(parseDollars('1.000,00', ',')).toBe(1000);
  });

  it('asks again for 9,75 where the phone writes a point, as a reading does, and reads the rest as before', () => {
    // Before, every comma was dropped, and 9,75 was saved as $975.00 an hour.
    expect(parseDollars('9,75')).toBeNaN();
    expect(parseDollars('24.50')).toBe(24.5);
    expect(parseDollars('1,000.00')).toBe(1000);
    expect(parseDollars(' 24 ')).toBe(24);
  });

  it('takes one dollar sign ahead of the amount or after it, spaces beside it, in either region', () => {
    expect(parseDollars('$24.50')).toBe(24.5);
    expect(parseDollars(' $ 24.50 ')).toBe(24.5);
    expect(parseDollars('24.50$')).toBe(24.5);
    expect(parseDollars('$24,50', ',')).toBe(24.5);
    expect(parseDollars('24,50 $', ',')).toBe(24.5);
  });

  it('keeps a third place as typed, for the store to round to the cent as it always has', () => {
    expect(parseDollars('24.505')).toBe(24.505);
    expect(parseDollars('24,505', ',')).toBe(24.505);
  });

  it('is nothing when nothing is typed, and turns back the rest', () => {
    expect(parseDollars('')).toBeUndefined();
    expect(parseDollars('   ', ',')).toBeUndefined();
    for (const mark of ['.', ','] as const) {
      for (const typed of ['$', '$$24', '24$50', '$24$', '-$24', '$-24', 'US$24', '24 dollars', '€24']) {
        expect({ mark, typed, read: parseDollars(typed, mark) }).toEqual({ mark, typed, read: Number.NaN });
      }
    }
  });
});

describe('a number written into a box for the person to keep or change', () => {
  it('is written with the phone’s own mark, so it reads back as the same number', () => {
    expect(withMark('8.00', ',')).toBe('8,00');
    expect(withMark('24.50', ',')).toBe('24,50');
    expect(withMark('1.5', ',')).toBe('1,5');
    expect(withMark('8', ',')).toBe('8');
    for (const text of ['8.00', '24.50', '1.5', '8']) expect(withMark(text, '.')).toBe(text);
    for (const mark of ['.', ','] as const) {
      expect(parseDecimal(withMark('8.00', mark), mark)).toBe(8);
      expect(parseDollars(withMark('1000.00', mark), mark)).toBe(1000);
    }
  });

  it('is how a reading is written', () => {
    for (const mark of ['.', ','] as const) {
      for (const n of [0, 12.5, 4250.5, 100.125]) expect(readingText(n, mark)).toBe(withMark(String(n), mark));
    }
  });
});

describe('a reading shown beside the box it is typed into', () => {
  it('is fmtMeter where the phone writes a point, as on the card, the exports and the PDF', () => {
    for (const n of [0, 12.5, 4250.5, 61_200, 1_234_567.85, READING_MAX]) {
      expect(meterText(n)).toBe(fmtMeter(n));
      expect(meterText(n, '.')).toBe(fmtMeter(n));
    }
    expect(meterText(4250.5)).toBe('4,250.5');
  });

  it('has the phone’s comma for a part where it writes one, and a space that does not break between thousands', () => {
    expect(meterText(4250.5, ',')).toBe('4 250,5');
    expect(meterText(12.5, ',')).toBe('12,5');
    expect(meterText(0, ',')).toBe('0,0');
    expect(meterText(1_234_567.85, ',')).toBe('1 234 567,9');
  });

  it('reads back as the reading it shows, in either region', () => {
    for (const mark of ['.', ','] as const) {
      for (const n of [0, 12.5, 4250.5, 61_200, READING_MAX]) expect({ mark, n, read: parseReading(meterText(n, mark), mark) }).toEqual({ mark, n, read: n });
    }
  });
});

describe('what to put right in the other boxes', () => {
  it('shows a part with the phone’s own mark', () => {
    expect(rateProblem()).toBe('Enter your hourly rate in dollars, like 24.00.');
    expect(rateProblem(',')).toBe('Enter your hourly rate in dollars, like 24,00.');
    expect(leaveHoursProblem()).toBe('Enter the hours for that day, between 0.25 and 24.');
    expect(leaveHoursProblem(',')).toBe('Enter the hours for that day, between 0,25 and 24.');
    expect(timeSpentProblem()).toBe('Enter the time spent in hours, like 1.5.');
    expect(timeSpentProblem(',')).toBe('Enter the time spent in hours, like 1,5.');
  });

  it('gives examples that read as numbers in their own region', () => {
    for (const mark of ['.', ','] as const) {
      expect(parseDollars(`24${mark}00`, mark)).toBe(24);
      expect(parseDecimal(`0${mark}25`, mark)).toBe(0.25);
      expect(parseDecimal(`1${mark}5`, mark)).toBe(1.5);
    }
  });
});

// Every screen that takes a reading reads it with this rule and the phone's own mark, so a minus sign is
// turned back the same way everywhere, 12,5 is twelve and a half where the phone writes it so, and none
// drops what it cannot read without a word.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));
const source = (file: string) => fs.readFileSync(`${root}/src/${file}`, 'utf8');
const SCREENS = ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx', 'screens/supervisor/FleetScreen.tsx'];

describe('the screens that take a reading', () => {
  it('read it with parseReading or readMeter, never with Number() alone', () => {
    for (const file of SCREENS) {
      const text = source(file);
      expect({ file, reads: /\b(parseReading|readMeter)\(/.test(text) }).toEqual({ file, reads: true });
      expect({ file, number: text.match(/Number\((meter|fuel|gallons)\b[^)]*\)/g) }).toEqual({ file, number: null });
    }
  });

  it('read it by the phone’s own decimal mark', () => {
    for (const file of SCREENS) {
      const text = source(file);
      expect({ file, mark: /const mark = useDecimalMark\(\);/.test(text) }).toEqual({ file, mark: true });
      const calls = text.match(/\b(?:parseReading|readMeter)\([^()]*\)/g) ?? [];
      expect({ file, without: calls.filter((c) => !/,\s*mark\)$/.test(c)) }).toEqual({ file, without: [] });
    }
  });

  it('write a reading into a box with the phone’s mark, never with String()', () => {
    for (const file of ['screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx']) {
      const text = source(file);
      expect({ file, string: text.match(/String\([^)]*meter\)/g) }).toEqual({ file, string: null });
      expect({ file, written: /readingText\([^()]*meter, mark\)/.test(text) }).toEqual({ file, written: true });
    }
  });

  it('say what is wrong with one in the same words, with the phone’s mark', () => {
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx']) {
      expect({ file, reading: /\breadingProblem\(mark\)/.test(source(file)) }).toEqual({ file, reading: true });
    }
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx']) {
      expect({ file, gallons: /\bgallonsProblem\(mark\)/.test(source(file)) }).toEqual({ file, gallons: true });
    }
    expect(/\bunitReadingProblem\(category, mark\)/.test(source('screens/supervisor/FleetScreen.tsx'))).toBe(true);
  });

  it('and the store turns a reading back in the same words, with the phone’s mark', () => {
    const store = source('store/useStore.ts');
    const said = store.match(/\b(?:readingProblem|gallonsProblem)\((?:[^()]|\(\))*\)/g) ?? [];
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((s) => !s.endsWith('(decimalMark())'))).toEqual([]);
    expect(store).toMatch(/newUnit\(equipment, input, newUnitId\(\), decimalMark\(\)\)/);
  });

  it('show the last reading beside the box with the phone’s mark, never with fmtMeter', () => {
    for (const file of ['screens/equipment/EndUseScreen.tsx', 'screens/equipment/InspectionScreen.tsx', 'screens/equipment/MrfFormScreen.tsx']) {
      const text = source(file);
      expect({ file, fmtMeter: text.match(/\bfmtMeter\(/g) }).toEqual({ file, fmtMeter: null });
      const shown = text.match(/\bmeterText\([^()]*\)/g) ?? [];
      expect(shown.length).toBeGreaterThan(0);
      expect({ file, without: shown.filter((c) => !/,\s*mark\)$/.test(c)) }).toEqual({ file, without: [] });
    }
  });
});

// The other boxes with a decimal pad: an hourly rate, hours of paid leave, the time spent on a maintenance
// request. The same keyboard sends the same keys, so they read by the same rule and the same mark.
const OTHER_BOXES = ['components/PayEstimate.tsx', 'components/LeaveSheet.tsx', 'screens/equipment/MrfDetailScreen.tsx'];

describe('the other screens that take a number with a part', () => {
  it('read it with parseDecimal or parseDollars and the phone’s mark, never with Number() or by dropping commas', () => {
    for (const file of OTHER_BOXES) {
      const text = source(file);
      expect({ file, mark: /const mark = useDecimalMark\(\);/.test(text) }).toEqual({ file, mark: true });
      const calls = text.match(/\b(?:parseDecimal|parseDollars)\([^()]*\)/g) ?? [];
      expect({ file, reads: calls.length > 0 }).toEqual({ file, reads: true });
      expect({ file, without: calls.filter((c) => !/,\s*mark\)$/.test(c)) }).toEqual({ file, without: [] });
      expect({ file, number: text.match(/Number\((hours|typed|text|cleaned|value)\b[^)]*\)/g) }).toEqual({ file, number: null });
      expect({ file, dropped: text.match(/\.replace\(\/\[[^\]]*,[^\]]*\]/g) }).toEqual({ file, dropped: null });
    }
  });

  it('write what they start with, and the example in the box, with the phone’s mark', () => {
    for (const file of OTHER_BOXES) {
      const text = source(file);
      expect({ file, written: /\bwithMark\([^()]*(?:\([^()]*\))?[^()]*, mark\)/.test(text) }).toEqual({ file, written: true });
      expect({ file, placeholder: text.match(/placeholder="[\d.,]+"/g) }).toEqual({ file, placeholder: null });
      expect({ file, fixed: text.match(/useState\('\d+\.\d+'\)|set\w+\('\d+\.\d+'\)/g) }).toEqual({ file, fixed: null });
    }
  });

  it('and the store and the screens turn one back in the same words, with the phone’s mark', () => {
    const store = source('store/useStore.ts');
    const said = store.match(/\b(?:rateProblem|leaveHoursProblem|timeSpentProblem)\((?:[^()]|\(\))*\)/g) ?? [];
    expect(said.length).toBe(3);
    expect(said.filter((s) => !s.endsWith('(decimalMark())'))).toEqual([]);
    expect(store).not.toMatch(/like 24\.00|between 0\.25|like 1\.5/);
    expect(source('screens/equipment/MrfDetailScreen.tsx')).toMatch(/\btimeSpentProblem\(mark\)/);
    for (const file of OTHER_BOXES) expect({ file, example: source(file).match(/like \d+\.\d+/g) }).toEqual({ file, example: null });
  });
});
