// A typed name must not be able to look like a claimed coworker's name while
// being a different string, or a request that displays as that coworker turns
// up as an ordinary 'not_on_roster' one, and a supervisor who approves it puts
// a second row on the roster that reads the same. So, in the database:
//  * no name holds an invisible character: every Default_Ignorable_Code_Point
//    and the rest of the format characters (Cf), not only the zero-width and
//    bidi ones (migration 20261116001800);
//  * names are composed (NFC) before they are stored or matched, so a
//    decomposed spelling is the same name as the composed one;
//  * a name does not mix Latin, Greek and Cyrillic letters, which have
//    look-alikes of each other;
//  * and a name that only looks like a name on the roster, written with other
//    characters (Cyrillic or Armenian look-alikes, small capitals, a Roman
//    numeral, a mathematical letter, a capital I for an l, rn for m), is
//    refused, typed or put on the roster (migration 20261116002500);
//  * a rule made stricter later is checked only when a name is written, so
//    it never blocks unrelated changes to an older row.
//
// All names are made up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addToRoster, BAD_INPUT, join, newMember, refused, rosterRow, startCompany, startDatabase } from './harness.mjs';

const ROSTER_SPELLING = /way it is written on the roster/;
const LOOKS_THE_SAME = /looks the same as/;

const cp = (n) => String.fromCodePoint(n);

// Invisible characters the first version of the check let through, one of each kind.
const INVISIBLE = {
  'combining grapheme joiner': 0x034f,
  'Hangul choseong filler': 0x115f,
  'Hangul jungseong filler': 0x1160,
  'Khmer vowel inherent aq': 0x17b4,
  'Khmer vowel inherent aa': 0x17b5,
  'Mongolian free variation selector': 0x180b,
  'Mongolian free variation selector four': 0x180f,
  'Hangul filler': 0x3164,
  'variation selector 1': 0xfe00,
  'variation selector 16': 0xfe0f,
  'halfwidth Hangul filler': 0xffa0,
  'reserved specials': 0xfff0,
  'shorthand format letter overlap': 0x1bca0,
  'musical symbol begin beam': 0x1d173,
  'tag space': 0xe0020,
  'tag latin capital a': 0xe0041,
  'cancel tag': 0xe007f,
  'variation selector 17': 0xe0100,
  'Arabic number sign': 0x0600,
  'Arabic end of ayah': 0x06dd,
  'Syriac abbreviation mark': 0x070f,
  'Arabic pound mark above': 0x0890,
  'Arabic disputed end of ayah': 0x08e2,
  'Braille pattern blank': 0x2800,
  'Kaithi number sign': 0x110bd,
  'Egyptian hieroglyph vertical joiner': 0x13430,
};

const LATIN_SMALL_I = 'i';
const CYRILLIC_SMALL_I = cp(0x0456); // looks like a Latin i
const COMBINING_ACUTE = cp(0x0301);

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const requestsOf = (account) => db.adminRows('select * from public.join_requests where user_id = $1 order by created_at, id', [account]);

describe('an invisible character in a typed name', () => {
  let company;
  before(async () => {
    company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    await newMember(db, company, 'Riley', 'Quinn');
  });

  for (const [what, point] of Object.entries(INVISIBLE)) {
    it(`is refused, so a request cannot pose as a claimed coworker: ${what} (U+${point.toString(16).toUpperCase()})`, async () => {
      const sly = await db.newAccount();
      await refused(join(db, sly, company.code, `Riley J${cp(point)}`, 'Quinn'), BAD_INPUT);
      await refused(join(db, sly, company.code, 'Riley J', `Qu${cp(point)}inn`), BAD_INPUT);
      assert.deepEqual(await requestsOf(sly), []);
    });
  }

  it('cannot be written into a roster name, a job title or a company name either', async () => {
    for (const point of Object.values(INVISIBLE)) {
      const insert = (first, title) =>
        db.as(company.owner).query('insert into public.roster (company_id, first_name, last_name, title) values ($1, $2, $3, $4)', [company.id, first, 'Park', title]);
      await refused(insert(`Lee${cp(point)}`, null), BAD_INPUT);
      await refused(insert('Lee', `Shop${cp(point)}`), BAD_INPUT);
      await refused(db.as(company.owner).query('update public.companies set name = $2 where id = $1', [company.id, `Test Pit${cp(point)} A`]), BAD_INPUT);
    }
  });
});

describe('a decomposed spelling', () => {
  it('is the same name as the composed one, so typing it for a claimed coworker says already_claimed', async () => {
    const company = await startCompany(db, { roster: [{ first: 'José', last: 'Ortega' }] });
    await newMember(db, company, 'José', 'Ortega');
    const sly = await db.newAccount();
    const result = await join(db, sly, company.code, `Jose${COMBINING_ACUTE}`, 'Ortega');
    assert.deepEqual(result, { status: 'pending', company_name: 'Test Pit A', reason: 'already_claimed' });
    const [request] = await requestsOf(sly);
    assert.equal(request.first_name, 'José', 'the request holds the composed name');
  });

  it('claims the right row, and is stored composed when a supervisor writes it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Zoë', last: 'Nguyễn' }] });
    const zoe = await db.newAccount();
    assert.equal((await join(db, zoe, company.code, `Zoe${cp(0x0308)}`, `Nguye${cp(0x0302)}${cp(0x0303)}n`)).status, 'joined');
    assert.equal((await rosterRow(db, company.rows['Zoë Nguyễn'])).user_id, zoe);

    const rowId = await addToRoster(db, company.owner, company.id, { first: `Jose${COMBINING_ACUTE}`, last: 'Ortega' });
    assert.equal((await rosterRow(db, rowId)).first_name, 'José');
  });
});

describe('letters from more than one alphabet', () => {
  it('are refused in a typed name, so a look-alike cannot pose as a claimed coworker', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Riley J', last: 'Quinn' }] });
    await newMember(db, company, 'Riley', 'Quinn');
    const sly = await db.newAccount();
    const lookAlike = (text) => text.replaceAll(LATIN_SMALL_I, CYRILLIC_SMALL_I);
    await refused(join(db, sly, company.code, lookAlike('Riley J'), 'Quinn'), BAD_INPUT, /alphabet/);
    await refused(join(db, sly, company.code, 'Riley J', lookAlike('Quinn')), BAD_INPUT, /alphabet/);
    assert.deepEqual(await requestsOf(sly), []);
  });

  it('are refused in a roster name', async () => {
    const company = await startCompany(db);
    await refused(
      db.as(company.owner).query("insert into public.roster (company_id, first_name, last_name) values ($1, $2, 'Quinn')", [company.id, `R${CYRILLIC_SMALL_I}ley`]),
      BAD_INPUT,
      /alphabet/,
    );
  });

  it('are fine one alphabet at a time, with accents', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Іван', last: 'Петренко' },
        { first: 'Ελένη', last: 'Καρρά' },
        { first: 'Renée', last: 'Dvořák' },
      ],
    });
    for (const [first, last] of [
      ['Іван', 'Петренко'],
      ['Ελένη', 'Καρρά'],
      ['Renée', 'Dvořák'],
    ]) {
      assert.equal((await join(db, await db.newAccount(), company.code, first, last)).status, 'joined', `${first} ${last}`);
    }
  });
});

describe('a rule made stricter later', () => {
  it('does not block unrelated changes to a row written before it, or deleting its account', async () => {
    const company = await startCompany(db);
    const holder = await db.newAccount();
    // A row written before the rule, the way an older migration allowed.
    await db.admin('alter table public.roster disable trigger roster_before_write');
    const [{ id }] = await db.adminRows(
      "insert into public.roster (company_id, first_name, last_name, user_id, claimed_at) values ($1, $2, 'Park', $3, now()) returning id",
      [company.id, `Lee${cp(0x034f)}`, holder],
    );
    await db.admin('alter table public.roster enable trigger roster_before_write');

    assert.equal(await db.as(company.owner).affected("update public.roster set title = 'Crusher' where id = $1", [id]), 1);
    await db.admin('delete from auth.users where id = $1', [holder]);
    assert.equal((await rosterRow(db, id)).user_id, null);
    // Writing the name again is held to the rule.
    await refused(db.as(company.owner).query('update public.roster set first_name = $2 where id = $1', [id, `Lee${cp(0x034f)} `]), BAD_INPUT);
  });
});

describe('a name that looks like a name on the roster, written with other characters', () => {
  // [roster first, roster last, typed first, typed last]
  const LOOK_ALIKES = {
    'wholly in Cyrillic': ['Joe', 'Cox', cp(0x0408) + cp(0x043e) + cp(0x0435), cp(0x0421) + cp(0x043e) + cp(0x0445)],
    'a small Roman numeral fifty for l': ['Kit', 'Marlow', 'Kit', `Mar${cp(0x217c)}ow`],
    'a Latin small capital O for o': ['Kit', 'Marlow', 'Kit', `Marl${cp(0x1d0f)}w`],
    'a mathematical sans-serif K': ['Kit', 'Marlow', `${cp(0x1d5aa)}it`, 'Marlow'],
    'an ASCII capital I for l': ['Kit', 'Marlow', 'Kit', 'MarIow'],
    'rn for m': ['Kit', 'Marlow', 'Kit', 'rnarlow'],
    'an Armenian o among Latin letters': ['Kit', 'Marlow', 'Kit', `Marl${cp(0x0585)}w`],
    'a Cherokee letter among Latin ones': ['Ana', 'Diaz', `${cp(0x13aa)}na`, 'Diaz'],
    'a fullwidth name': ['Kit', 'Marlow', 'Ｋｉｔ', 'Ｍａｒｌｏｗ'],
  };

  for (const [what, [first, last, typedFirst, typedLast]] of Object.entries(LOOK_ALIKES)) {
    it(`is refused when typed for a claimed coworker, rather than left as an innocent request: ${what}`, async () => {
      const company = await startCompany(db, { roster: [{ first, last }] });
      await newMember(db, company, first, last);
      const sly = await db.newAccount();
      await refused(join(db, sly, company.code, typedFirst, typedLast), BAD_INPUT, ROSTER_SPELLING);
      assert.deepEqual(await requestsOf(sly), []);
    });

    it(`cannot be put on the roster beside the name it looks like: ${what}`, async () => {
      const company = await startCompany(db, { roster: [{ first, last }] });
      await refused(addToRoster(db, company.owner, company.id, { first: typedFirst, last: typedLast }), BAD_INPUT, LOOKS_THE_SAME);
      assert.equal((await db.adminRows('select count(*)::int as n from public.roster where company_id = $1', [company.id]))[0].n, 2);
    });
  }

  it('is refused for an unclaimed coworker, a coworker taken off the roster, and the looser way of writing a name', async () => {
    const company = await startCompany(db, {
      roster: [{ first: 'Kit J', last: 'Marlow' }, { first: 'Bo', last: 'Ellison', active: false }],
    });
    const sly = await db.newAccount();
    // Kit J Marlow, written without the initial and with a capital I for the l.
    await refused(join(db, sly, company.code, 'Kit', 'MarIow'), BAD_INPUT, ROSTER_SPELLING);
    await refused(join(db, sly, company.code, 'B' + cp(0x043e), 'Ellison'), BAD_INPUT);
    await refused(join(db, sly, company.code, 'Bo', `E${cp(0x217c)}lison`), BAD_INPUT, ROSTER_SPELLING);
    assert.deepEqual(await requestsOf(sly), []);
  });

  it('is refused for a removed person too, so their request cannot pose as a coworker', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    const kit = await newMember(db, company, 'Kit', 'Marlow');
    await db.as(company.owner).affected('update public.roster set active = false where id = $1', [company.rows['Kit Marlow']]);
    await refused(join(db, kit, company.code, 'Bo', 'EIlison'), BAD_INPUT, ROSTER_SPELLING);
    assert.equal((await join(db, kit, company.code, 'Kit', 'Marlow')).reason, 'removed');
  });

  it('left as a request before this rule, cannot be approved into a second row that reads the same', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    await newMember(db, company, 'Kit', 'Marlow');
    const sly = await db.newAccount();
    const [request] = await db.adminRows(
      "insert into public.join_requests (company_id, user_id, first_name, last_name, reason) values ($1, $2, 'Kit', 'MarIow', 'not_on_roster') returning id",
      [company.id, sly],
    );
    await refused(db.as(company.owner).call('approve_join_request', { request_id: request.id }), BAD_INPUT, LOOKS_THE_SAME);
    assert.equal((await db.adminRows("select status from public.join_requests where id = $1", [request.id]))[0].status, 'pending');
    assert.equal(await db.as(sly).call('is_member', { company_id: company.id }), false);
  });

  it('cannot come in by renaming a row, or two at once in one statement', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }, { first: 'Bo', last: 'Ellison' }] });
    await refused(
      db.as(company.owner).query("update public.roster set first_name = 'Kit', last_name = 'MarIow' where id = $1", [company.rows['Bo Ellison']]),
      BAD_INPUT,
      LOOKS_THE_SAME,
    );
    await refused(
      db.as(company.owner).query("insert into public.roster (company_id, first_name, last_name) values ($1, 'Lou', 'Penrose'), ($1, 'Lou', 'Penr0se')", [company.id]),
      BAD_INPUT,
      LOOKS_THE_SAME,
    );
    assert.equal((await rosterRow(db, company.rows['Bo Ellison'])).last_name, 'Ellison');
  });

  it('is told apart from names that only differ, and from names written the same', async () => {
    const company = await startCompany(db, {
      roster: [
        { first: 'Ian', last: 'Park' },
        { first: 'Lee', last: 'Park', title: 'Crusher' },
        { first: 'Lee', last: 'Park', title: 'Haul truck' },
        { first: 'Pat', last: "O'Neil" },
        { first: 'Іван', last: 'Петренко' },
      ],
    });
    // A capital L is not the capital I that looks like a small l.
    assert.deepEqual(await join(db, await db.newAccount(), company.code, 'Lan', 'Park'), { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' });
    await addToRoster(db, company.owner, company.id, { first: 'Lan', last: 'Park' });
    // A phone's curly apostrophe is the looser way of writing the same name: it claims the row.
    assert.equal((await join(db, await db.newAccount(), company.code, 'Pat', `O${cp(0x2019)}Neil`)).status, 'joined');
    // Lee Park twice, written the same, stays allowed: no typing can single one out.
    assert.equal((await join(db, await db.newAccount(), company.code, 'Lee', 'Park')).reason, 'ambiguous');
    assert.equal((await join(db, await db.newAccount(), company.code, 'Іван', 'Петренко')).status, 'joined');
  });

  it('as a stricter rule, does not block unrelated changes to rows written before it', async () => {
    const company = await startCompany(db, { roster: [{ first: 'Kit', last: 'Marlow' }] });
    await db.admin('alter table public.roster disable trigger roster_names_look_apart_on_insert');
    const [{ id }] = await db.adminRows("insert into public.roster (company_id, first_name, last_name) values ($1, 'Kit', 'MarIow') returning id", [company.id]);
    await db.admin('alter table public.roster enable trigger roster_names_look_apart_on_insert');
    assert.equal(await db.as(company.owner).affected("update public.roster set title = 'Crusher' where company_id = $1", [company.id]), 3);
    assert.equal(await db.as(company.owner).affected('update public.roster set active = false where id = $1', [id]), 1);
    // Writing a name to it again is held to the rule.
    await refused(db.as(company.owner).query("update public.roster set last_name = 'Mar1ow' where id = $1", [id]), BAD_INPUT, LOOKS_THE_SAME);
  });
});
