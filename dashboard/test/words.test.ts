import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as changes from '../src/lib/changes';
import * as history from '../src/lib/history';
import * as rosterPeople from '../src/lib/rosterPeople';
import * as setup from '../src/lib/setup';

/**
 * Phones receive what the Roster, Fleet, Exam sheets and Company pages save,
 * the next time each is open with signal. Nothing the dashboard says may still
 * tell a supervisor that they do not: no constant, no string on a page and no
 * comment beside the code that says it.
 */

const STALE = [
  'do not receive',
  'until the app is updated to receive',
  'keep their own',
  'can still send its own copy',
  'puts it back when it next sends',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** A file's text as it reads: a sentence wrapped over two lines of JSX, or split across a template, is one sentence. */
const asRead = (text: string) => text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();

/** Every string a module exports, down through its lists and objects. */
function strings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) strings(v, out, seen);
  }
  return out;
}

describe('what the dashboard says about the phones', () => {
  const pages = [...files(path.join(src, 'lib')), ...files(path.join(src, 'screens'))];

  it('reads every file of the pages and their rules', () => {
    const names = pages.map((f) => path.relative(src, f));
    for (const name of ['lib/setup.ts', 'lib/history.ts', 'lib/rosterPeople.ts', 'screens/RosterPage.tsx', 'screens/FleetPage.tsx', 'screens/CompanyPage.tsx', 'screens/ExamSheetsPage.tsx', 'screens/setupNotices.tsx']) {
      expect(names).toContain(name);
    }
  });

  it('never says, in a string or a comment, that phones do not receive what is saved here', () => {
    const found = pages.flatMap((file) => {
      const text = asRead(readFileSync(file, 'utf8'));
      return STALE.filter((words) => text.includes(words)).map((words) => `${path.relative(src, file)}: “${words}”`);
    });
    expect(found).toEqual([]);
  });

  it('never says it in a constant either, however it is put together', () => {
    const said = [setup, history, changes, rosterPeople].flatMap((m) => strings(m)).map(asRead);
    expect(said.length).toBeGreaterThan(10);
    for (const words of STALE) expect(said.filter((s) => s.includes(words))).toEqual([]);
  });

  it('sends a supervisor to the Company page, not the app’s More → Company, for what that page saves', () => {
    // "More → Company account" is the app's screen for joining a company, which is still where that is done.
    const found = pages.flatMap((file) => {
      const text = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      return /More → Company(?! account)/.test(text) ? [path.relative(src, file)] : [];
    });
    expect(found).toEqual([]);
  });

  it('never says a person’s employee record comes from the phones', () => {
    const found = pages.flatMap((file) => (asRead(readFileSync(file, 'utf8')).includes('employee record from the phones') ? [path.relative(src, file)] : []));
    expect(found).toEqual([]);
  });

  it('says how phones get what is saved here, on every page that saves', () => {
    expect(setup.HOW_PHONES_GET_IT).toBe('How the crew’s phones get what is saved here');
    expect(setup.SAVED_FOR_PHONES).toBe('Saved to the company. Phones get it the next time they are open with signal.');
    expect(rosterPeople.PEOPLE_SAVED).toBe('Saved. Phones get it the next time they are open with signal.');
  });
});
