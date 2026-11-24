import { changedSheet, newSheet, parseAreaSheets, SAMPLE_AREA_SHEETS, sheetInUse } from '../areaExam';
import type { AreaSheet } from '../types';

/**
 * Adding a sheet, changing one and taking one off the list: the rules the app's
 * store and the office dashboard both go by. Every area and line here is made
 * up, like the samples.
 */

const WASH = 'Wash bay';
const WASH_LINES = 'Hose reel\nDrain grate';
const MORE_LINES = 'Hose reel\nDrain grate\nOil separator';
const OTHER = 'Truck wash';

const added = (sheets: readonly AreaSheet[], title: string, rows: string, single?: boolean): AreaSheet => {
  const made = newSheet(sheets, title, rows, single);
  if (!made.ok) throw new Error(made.error);
  return made.sheet;
};

describe('adding an area sheet', () => {
  it('makes a sheet in use, with an id from its name and a line for each line typed', () => {
    expect(newSheet(SAMPLE_AREA_SHEETS, ` ${WASH} `, `${WASH_LINES}\n\n`)).toEqual({
      ok: true,
      sheet: { id: 'wash_bay', title: WASH, rows: [{ id: 'hose_reel', label: 'Hose reel' }, { id: 'drain_grate', label: 'Drain grate' }], active: true },
    });
  });

  it('needs the name of its work area', () => {
    expect(newSheet(SAMPLE_AREA_SHEETS, '   ', WASH_LINES)).toEqual({ ok: false, error: 'Give the sheet the name of its work area.' });
  });

  it('will not take the name of a sheet already there, whatever its capitals, in use or not', () => {
    const sheets = [...SAMPLE_AREA_SHEETS, sheetInUse(added(SAMPLE_AREA_SHEETS, WASH, WASH_LINES), false)];
    expect(newSheet(sheets, 'wash BAY', 'Hose reel')).toEqual({ ok: false, error: `There is already a sheet called ${WASH}.` });
    expect(newSheet(sheets, `${WASH} areas:`, 'Hose reel')).toEqual({ ok: false, error: `There is already a sheet called ${WASH}.` });
  });

  it('never shares an id with a sheet that is there under another name', () => {
    // "Wash-bay" and "Wash bay" are different names with the same slug.
    const sheets = [added([], 'Wash-bay', '')];
    expect(added(sheets, WASH, '').id).toBe('wash_bay_2');
  });

  it('has one OK/BO column when it is said, or when [OK/BO] is typed after the name', () => {
    expect(added([], WASH, WASH_LINES, true).single).toBe(true);
    expect(added([], `${WASH} [OK/BO]`, WASH_LINES)).toMatchObject({ title: WASH, single: true });
    expect('single' in added([], WASH, WASH_LINES, false)).toBe(false);
    expect('single' in added([], WASH, WASH_LINES)).toBe(false);
  });

  it('can start with no lines of its own', () => {
    expect(added([], WASH, '').rows).toEqual([]);
  });
});

describe('changing an area sheet', () => {
  const wash = added(SAMPLE_AREA_SHEETS, WASH, WASH_LINES);
  const sheets = [...SAMPLE_AREA_SHEETS, wash];

  it('changes its name and its lines and keeps its id', () => {
    expect(changedSheet(sheets, 'wash_bay', OTHER, MORE_LINES)).toEqual({
      ok: true,
      sheet: {
        id: 'wash_bay',
        title: OTHER,
        rows: [{ id: 'hose_reel', label: 'Hose reel' }, { id: 'drain_grate', label: 'Drain grate' }, { id: 'oil_separator', label: 'Oil separator' }],
        active: true,
      },
    });
  });

  it('keeps the columns it has when nothing is said about them, and changes them when something is', () => {
    const single = [added([], WASH, WASH_LINES, true)];
    const kept = changedSheet(single, 'wash_bay', WASH, MORE_LINES);
    expect(kept.ok && kept.sheet.single).toBe(true);
    const three = changedSheet(single, 'wash_bay', WASH, MORE_LINES, false);
    expect(three.ok && 'single' in three.sheet).toBe(false);
    const one = changedSheet(sheets, 'wash_bay', WASH, WASH_LINES, true);
    expect(one.ok && one.sheet.single).toBe(true);
  });

  it('leaves a sheet that is off the list off it', () => {
    const off = [sheetInUse(wash, false)];
    const made = changedSheet(off, 'wash_bay', OTHER, WASH_LINES);
    expect(made.ok && made.sheet.active).toBe(false);
  });

  it('keeps anything else the record holds', () => {
    const more = [{ ...wash, note: 'kept' } as AreaSheet];
    const made = changedSheet(more, 'wash_bay', WASH, WASH_LINES);
    expect(made.ok && made.sheet).toEqual(more[0]);
  });

  it('may keep its own name, and may not take another sheet’s', () => {
    expect(changedSheet(sheets, 'wash_bay', 'WASH BAY', WASH_LINES)).toMatchObject({ ok: true, sheet: { title: 'WASH BAY' } });
    const taken = SAMPLE_AREA_SHEETS[0].title;
    expect(changedSheet(sheets, 'wash_bay', taken.toUpperCase(), WASH_LINES)).toEqual({ ok: false, error: `There is already a sheet called ${taken}.` });
  });

  it('needs a name, and a sheet that is still on the list', () => {
    expect(changedSheet(sheets, 'wash_bay', '  ', WASH_LINES)).toEqual({ ok: false, error: 'Give the sheet the name of its work area.' });
    expect(changedSheet(sheets, 'no_such_sheet', WASH, WASH_LINES)).toEqual({ ok: false, error: 'That area sheet is no longer on the list.' });
  });

  it('hands back a new sheet and leaves the one it was given as it was', () => {
    const before = JSON.stringify(wash);
    const made = changedSheet(sheets, 'wash_bay', OTHER, MORE_LINES, true);
    expect(made.ok && made.sheet).not.toBe(wash);
    expect(JSON.stringify(wash)).toBe(before);
  });
});

describe('taking a sheet off the list and putting it back', () => {
  it('changes only whether it is in use', () => {
    const wash = added([], WASH, WASH_LINES, true);
    expect(sheetInUse(wash, false)).toEqual({ ...wash, active: false });
    expect(sheetInUse(sheetInUse(wash, false), true)).toEqual(wash);
  });
});

describe('the made-up words these tests use', () => {
  // The mine's own sheets are private and this repository is public (see AGENTS.md). Jest does
  // not load .env.local, so this reads it itself, and only where a build on this machine names
  // its sheets there. Only the made-up words above are printed if it fails.
  const named = (() => {
    const fs = jest.requireActual<{ existsSync(file: string): boolean; readFileSync(file: string, encoding: 'utf8'): string }>('fs');
    const here = expect.getState().testPath ?? '';
    const file = `${here.slice(0, here.search(/[\\/]src[\\/]/))}/.env.local`;
    if (!fs.existsSync(file)) return [];
    const found = fs.readFileSync(file, 'utf8').match(/^EXPO_PUBLIC_AREA_SHEETS=(?:"([\s\S]*?)"|'([\s\S]*?)'|(.*))$/m);
    return parseAreaSheets(found?.[1] ?? found?.[2] ?? found?.[3]);
  })();

  (named.length ? it : it.skip)('repeat no area and no line of the sheets a build on this machine names', () => {
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const own = new Set(named.flatMap((s) => [s.title, ...s.rows.map((r) => r.label)]).map(plain));
    const mine = [WASH, OTHER, 'Wash-bay', ...MORE_LINES.split('\n')];
    expect(mine.filter((text) => own.has(plain(text)))).toEqual([]);
  });
});
