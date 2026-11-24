// The name matching in the database behaves the same as findOnRoster in
// src/domain/roster.ts: the cases of its tests in
// src/domain/__tests__/roster.test.ts, and every pairing of a few hundred
// typed names checked against findOnRoster itself.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addToRoster, startCompany, startDatabase } from './harness.mjs';

const NO_BREAK_SPACE = String.fromCharCode(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);
const APOSTROPHE = String.fromCharCode(0x2019);

// The app's own rules, when Node can load them (it strips the types from a .ts file).
let app = null;
let appMissing = '';
try {
  app = await import('../../src/domain/roster.ts');
  if (typeof app.findOnRoster !== 'function') throw new Error('findOnRoster is not exported');
} catch (error) {
  app = null;
  appMissing = `src/domain/roster.ts could not be loaded: ${error.message}`;
}

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

/** A company whose active roster is these people, in this order. Rows are keyed "First Last". */
async function companyOf(people) {
  const [first, ...rest] = people;
  const company = await startCompany(db, { supervisor: [first.firstName, first.lastName] });
  for (const p of rest) await addToRoster(db, company.owner, company.id, { first: p.firstName, last: p.lastName, active: p.active ?? true }, company.rows);
  return company;
}

/** Who find_on_roster says a typed name is: null, "First Last", or a list of them. */
async function found(company, first, last) {
  const rows = await db.adminRows(
    "select first_name || ' ' || last_name as name from public.find_on_roster($1, $2, $3) order by created_at, id",
    [company.id, first, last],
  );
  if (rows.length === 0) return null;
  return rows.length === 1 ? rows[0].name : rows.map((r) => r.name);
}

describe('find_on_roster, with the cases of findOnRoster', () => {
  const people = [
    { firstName: 'Sam', lastName: 'Ortiz' },
    { firstName: 'Riley J', lastName: 'Quinn' },
    { firstName: 'Lee "Buck"', lastName: 'Vance III' },
    { firstName: 'Maria', lastName: 'De La Cruz' },
  ];
  let company;
  before(async () => {
    company = await companyOf(people);
  });

  const known = [
    ['sam', 'ORTIZ', 'Sam Ortiz'],
    // A middle initial can be left off, or typed.
    ['Riley', 'Quinn', 'Riley J Quinn'],
    ['riley j.', 'quinn', 'Riley J Quinn'],
    // Someone who goes by a nickname can type either name, with or without "III".
    ['Lee', 'Vance', 'Lee "Buck" Vance III'],
    ['Buck', 'Vance III', 'Lee "Buck" Vance III'],
    ['Lee Buck', 'vance iii', 'Lee "Buck" Vance III'],
    ['Maria', 'de la Cruz', 'Maria De La Cruz'],
  ];
  for (const [first, last, name] of known) {
    it(`knows ${first} ${last} as ${name}`, async () => {
      assert.equal(await found(company, first, last), name);
    });
  }

  const unknown = [
    ['Samuel', 'Ortiz'],
    ['Sam', 'Ortega'],
    // An initial alone is not a name.
    ['J', 'Quinn'],
    ['Riley', 'Quinn Jr'],
    ['Lee', 'Vance IV'],
    ['Maria', 'Cruz'],
    ['', 'Ortiz'],
  ];
  for (const [first, last] of unknown) {
    it(`does not know ${first} ${last}`, async () => {
      assert.equal(await found(company, first, last), null);
    });
  }

  it('says so when a name fits more than one person, and takes the one it fits exactly', async () => {
    const parks = await companyOf([
      { firstName: 'Lee', lastName: 'Park' },
      { firstName: 'Lee Roy', lastName: 'Park' },
      { firstName: 'Roy "Lee"', lastName: 'Park' },
    ]);
    // Typed exactly as one of them is on the roster: that one.
    assert.equal(await found(parks, 'Lee', 'Park'), 'Lee Park');
    // "Roy Park" fits two people, and neither exactly.
    assert.deepEqual(await found(parks, 'Roy', 'Park'), ['Lee Roy Park', 'Roy "Lee" Park']);
  });
});

describe('find_on_roster, beyond those cases', () => {
  it('trims and closes up every kind of space, as cleanText does', async () => {
    const company = await companyOf([{ firstName: 'Sam', lastName: 'Ortiz' }, { firstName: 'Maria', lastName: 'De La Cruz' }]);
    assert.equal(await found(company, `${NO_BREAK_SPACE}sam${IDEOGRAPHIC_SPACE}`, ' ortiz\t'), 'Sam Ortiz');
    assert.equal(await found(company, 'MARIA', `de${NO_BREAK_SPACE} la   cruz`), 'Maria De La Cruz');
  });

  it('reads curly quotes and apostrophes like straight ones', async () => {
    const company = await companyOf([{ firstName: 'Lee "Buck"', lastName: 'Vance III' }, { firstName: 'Pat', lastName: "O'Neil-Smith" }]);
    assert.equal(await found(company, `Lee ${LEFT_QUOTE}Buck${RIGHT_QUOTE}`, 'Vance'), 'Lee "Buck" Vance III');
    assert.equal(await found(company, 'pat', `o${APOSTROPHE}neil smith`), "Pat O'Neil-Smith");
  });

  it('matches only active rows', async () => {
    const company = await companyOf([
      { firstName: 'Sam', lastName: 'Ortiz' },
      { firstName: 'Riley J', lastName: 'Quinn', active: false },
      { firstName: 'Lee', lastName: 'Park' },
      { firstName: 'Lee', lastName: 'Park', active: false },
      { firstName: 'Lee Roy', lastName: 'Park', active: false },
    ]);
    assert.equal(await found(company, 'Riley', 'Quinn'), null);
    assert.equal(await found(company, 'Riley J', 'Quinn'), null);
    // An inactive row neither makes a name ambiguous nor takes it.
    assert.equal(await found(company, 'Lee', 'Park'), 'Lee Park');
    assert.equal(await found(company, 'Roy', 'Park'), null);
  });

  it('keeps to its own company', async () => {
    const a = await companyOf([{ firstName: 'Sam', lastName: 'Ortiz' }]);
    const b = await companyOf([{ firstName: 'Kit', lastName: 'Marlow' }]);
    assert.equal(await found(a, 'Kit', 'Marlow'), null);
    assert.equal(await found(b, 'Kit', 'Marlow'), 'Kit Marlow');
  });
});

describe('find_on_roster against findOnRoster itself', () => {
  // Made-up people, as in src/domain/__tests__/roster.test.ts.
  const people = [
    { firstName: 'Sam', lastName: 'Ortiz' },
    { firstName: 'Riley J', lastName: 'Quinn' },
    { firstName: 'Lee "Buck"', lastName: 'Vance III' },
    { firstName: 'Maria', lastName: 'De La Cruz' },
    { firstName: 'Maria Elena', lastName: 'De La Cruz' },
    { firstName: 'Lee', lastName: 'Park' },
    { firstName: 'Lee Roy', lastName: 'Park' },
    { firstName: 'Roy "Lee"', lastName: 'Park' },
    { firstName: 'Pat', lastName: "O'Neil-Smith" },
    { firstName: 'Pat', lastName: 'Cole' },
    { firstName: 'Ana', lastName: 'Diaz' },
    { firstName: 'Jo', lastName: 'Sterne Jr' },
    { firstName: 'Dale', lastName: 'Sterne' },
    { firstName: 'Kit', lastName: 'Marlow' },
    { firstName: 'Bo', lastName: 'Marlow' },
    { firstName: 'Lou', lastName: 'Marlow V' },
    { firstName: 'Val', lastName: 'V' },
  ];

  /** What people might type: every name as written, its words, other capitals, spacing and punctuation, and some near misses. */
  function typedNames() {
    const firsts = new Set(['', ' ', 'J', 'J.', 'R J', 'Samuel', 'Elena', 'maria-elena', 'Roy Lee', 'Lee-Roy', 'Lee.', 'Buck Lee', `  LEE${NO_BREAK_SPACE}`]);
    const lasts = new Set(['', 'Ortega', 'Cruz', 'DeLaCruz', 'Quinn Jr', 'Vance IV', 'vance iii', 'Sterne Sr', 'sterne jr.', "O'Neil Smith", 'o neil smith', 'Park III', 'Marlow V', `${NO_BREAK_SPACE}park `]);
    for (const { firstName, lastName } of people) {
      firsts.add(firstName);
      firsts.add(firstName.toLowerCase());
      for (const word of firstName.replace(/"/g, '').split(' ')) firsts.add(word);
      lasts.add(lastName);
      lasts.add(lastName.toUpperCase());
      lasts.add(lastName.replace(/ (Jr|III)$/, ''));
    }
    const pairs = [];
    for (const first of firsts) for (const last of lasts) pairs.push([first, last]);
    return pairs;
  }

  it('agrees on who every typed name is, or that it is nobody, or several people', { skip: app ? false : appMissing }, async () => {
    const company = await companyOf(people);
    const ids = people.map((p) => company.rows[`${p.firstName} ${p.lastName}`]);
    const pairs = typedNames();
    assert.ok(pairs.length > 1000, `${pairs.length} pairs`);
    console.log(`compared ${pairs.length} typed names`);

    const rows = await db.adminRows(
      `select t.i::int as i, coalesce(jsonb_agg(f.id) filter (where f.id is not null), '[]') as ids
       from jsonb_array_elements($2::jsonb) with ordinality as t(pair, i)
       left join lateral public.find_on_roster($1, t.pair ->> 0, t.pair ->> 1) f on true
       group by t.i
       order by t.i`,
      [company.id, JSON.stringify(pairs)],
    );
    assert.equal(rows.length, pairs.length);

    const kinds = { none: 0, one: 0, several: 0 };
    pairs.forEach(([first, last], n) => {
      const hit = app.findOnRoster(people, first, last);
      const expected = hit === null ? [] : 'person' in hit ? [hit.person] : hit.several;
      const expectedIds = expected.map((p) => ids[people.indexOf(p)]).sort();
      assert.deepEqual([...rows[n].ids].sort(), expectedIds, `"${first}" "${last}"`);
      kinds[expected.length === 0 ? 'none' : expected.length === 1 ? 'one' : 'several'] += 1;
    });
    // The pairings reach every outcome, many times over.
    for (const [kind, n] of Object.entries(kinds)) assert.ok(n >= 10, `only ${n} pairings come to ${kind}`);
  });
});

describe('find_on_roster beyond plain ASCII', () => {
  const cp = (n) => String.fromCodePoint(n);
  // Made-up people written in Greek, with the final sigma where Greek puts it.
  const greek = [
    { firstName: 'Νίκος', lastName: 'Καρράς' },
    { firstName: 'Γιώργος Αλέξης', lastName: 'Σταύρου' },
  ];
  const typedGreek = [
    // All capitals, as a phone's caps lock types them: every sigma is the capital one.
    ['ΝΊΚΟΣ', 'ΚΑΡΡΆΣ', 0],
    ['ΑΛΈΞΗΣ', 'ΣΤΑΎΡΟΥ', 1],
    // Lower case, with a medial sigma typed at the end of the word.
    ['νίκοσ', 'καρράσ', 0],
  ];

  it('treats the final sigma as the sigma it is, in capitals or not', async () => {
    const company = await companyOf(greek);
    for (const [first, last, who] of typedGreek) {
      const p = greek[who];
      assert.equal(await found(company, first, last), `${p.firstName} ${p.lastName}`, `"${first}" "${last}"`);
    }
  });

  it('agrees with findOnRoster on Greek names typed in capitals', { skip: app ? false : appMissing }, async () => {
    const company = await companyOf(greek);
    for (const [first, last] of typedGreek.slice(0, 2)) {
      const hit = app.findOnRoster(greek, first, last);
      const expected = hit === null ? null : 'person' in hit ? `${hit.person.firstName} ${hit.person.lastName}` : hit.several.map((p) => `${p.firstName} ${p.lastName}`);
      assert.deepEqual(await found(company, first, last), expected, `"${first}" "${last}"`);
    }
  });

  // These need the same folding in src/domain/roster.ts, which this step does
  // not change: compose the text (normalize('NFC')) in cleanText, turn a
  // capital I with a dot (U+0130) into I before toLowerCase and a final sigma
  // into a medial one after it, and count a word's length in code points
  // ([...word].length) for the "an initial is not a name" rule.
  it('agrees with findOnRoster on a dotted capital I, a decomposed accent and a letter outside the BMP', {
    skip: app ? false : appMissing,
    todo: 'needs the same folding in src/domain/roster.ts',
  }, async () => {
    const people = [
      { firstName: 'Ibrahim', lastName: 'Demir' },
      { firstName: `${cp(0x20bb7)} Kit`, lastName: 'Marlow' },
      { firstName: 'José', lastName: 'Ortega' },
    ];
    const company = await companyOf(people);
    for (const [first, last] of [[`${cp(0x130)}BRAHIM`, 'DEMIR'], [cp(0x20bb7), 'Marlow'], [`Jose${cp(0x301)}`, 'Ortega']]) {
      const hit = app.findOnRoster(people, first, last);
      const expected = hit === null ? null : 'person' in hit ? `${hit.person.firstName} ${hit.person.lastName}` : hit.several.map((p) => `${p.firstName} ${p.lastName}`);
      assert.deepEqual(await found(company, first, last), expected, `"${first}" "${last}"`);
    }
  });
});
