import { describe, expect, it } from 'vitest';

import type { Company } from '@app/domain/company';
import type { Employee, Shift } from '@app/domain/types';

import {
  ADD_TO_APP,
  addPeople,
  addToApp,
  appPeople,
  CLOCK_ANSWERS,
  clockQuestion,
  finishAdding,
  halfWhy,
  inAppAlready,
  keptIds,
  onRosterAsWords,
  letInOnNewRow,
  makeBoth,
  newPersonId,
  notInApp,
  notInAppWords,
  notInAppYetWords,
  notLoadedCrewWords,
  notLoadedOffWords,
  notOnRosterNowWords,
  offRosterWords,
  oneAtATime,
  onRosterWords,
  onTheClock,
  PEOPLE_NOT_LOADED,
  PEOPLE_SAVED,
  personRefusedWords,
  planAdd,
  roleMismatch,
  ROSTER_LEDE,
  rowPerson,
  ROSTER_LEDE_SAFETY_ONLY,
  rowNotChangedWords,
  rowStillOnWords,
  savePayrollId,
  changeRow,
  sharedRowWords,
  takeOff,
  takeOffApp,
  takenOffQuestion,
  twoNotChangedWords,
  twoOffWords,
  twoPeopleWords,
  type Ids,
  type PeopleWrites,
  type PersonSaved,
  type Rosters,
} from '../src/lib/rosterPeople';
import type { RosterRow } from '../src/lib/server';
import { rosterRow } from './fixtures';

/**
 * The Roster page writes a person twice: the sign-in row on the server and the
 * person in the app's roster, which is what phones receive. Each change is
 * written in an order that never says the wrong thing when one of the two
 * fails. Every name here is made up, the same made-up names as the other tests.
 */

const person = (id: string, firstName: string, lastName: string, over: Partial<Employee> = {}): Employee => ({
  id, firstName, lastName, role: 'employee', active: true, ...over,
});

const ortiz = person('emp_ortiz', 'Sam', 'Ortiz', { title: 'Crusher' });
const quinn = person('emp_quinn', 'Riley J', 'Quinn', { role: 'supervisor', payrollId: '2001' });
const park = person('emp_park', 'Lee', 'Park');

const ortizRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', title: 'Crusher' });
const NO_SIGNAL = 'Could not reach the MineMuster server. Check this computer’s connection, then try again.';

/** A stand-in for the page's writes: each says what it did, in the order it did it, and any of them can be made to fail. */
function writes(fail: { person?: (p: Employee) => PersonSaved | undefined; rows?: Error; update?: Error; remove?: Error } = {}) {
  const log: string[] = [];
  const saved: Employee[] = [];
  const io: PeopleWrites = {
    savePerson: async (p) => {
      log.push(`person ${p.id}`);
      const refused = fail.person?.(p);
      if (refused) return refused;
      saved.push(p);
      return { ok: true };
    },
    addRows: async (rows) => {
      log.push(`add rows ${rows.map((r) => `${r.firstName} ${r.lastName}`).join(', ')}`);
      if (fail.rows) throw fail.rows;
      return [];
    },
    updateRow: async (id, patch) => {
      log.push(`update row ${id} ${JSON.stringify(patch)}`);
      if (fail.update) throw fail.update;
    },
    deleteRow: async (id) => {
      log.push(`delete row ${id}`);
      if (fail.remove) throw fail.remove;
    },
  };
  return { io, log, saved };
}

/** New people's ids, in turn, kept for each name as the page keeps them. */
const ids = (...list: string[]): Ids => {
  let i = 0;
  return keptIds(() => list[i++] ?? `emp_spare${i}`);
};

/** Both rosters as the page holds them. */
const both = (people: Employee[], rows: RosterRow[] = [], named: Employee[] = []): Rosters => ({ people, named, rows });

const PIT: Company = { name: 'Test Pit A', state: 'NV', pay: null };

describe('the words of the page', () => {
  it('says what the page is for, and when phones have a change', () => {
    expect(ROSTER_LEDE).toBe('The sign-in roster, and the roster in the app. People are added, taken off and given a role or a payroll ID here; phones have the change the next time they are open with signal.');
    // A company that keeps no time has no payroll IDs, and the page does not speak of them.
    expect(ROSTER_LEDE_SAFETY_ONLY).not.toMatch(/payroll/i);
    expect(PEOPLE_SAVED).toBe('Saved. Phones get it the next time they are open with signal.');
  });

  it('gives a new person an id made the way the app makes one', () => {
    expect(newPersonId()).toMatch(/^emp_[a-z0-9]{12,}$/);
    expect(newPersonId()).not.toBe(newPersonId());
  });
});

describe('who is in the app', () => {
  it('is the people the records hold, not the ones a page named only from the sign-in roster for their hours', () => {
    const named = person('emp_named', 'Dana', 'Whitfield');
    expect(appPeople([ortiz, named, park], new Set(['emp_named']))).toEqual([ortiz, park]);
  });

  it('puts a sign-in row with nobody in the app for it under its own heading, and never a row taken off', () => {
    const rows = [
      ortizRow,
      // A loose fit is the same person: the app's roster may carry a middle initial the row leaves off.
      rosterRow({ first_name: 'Riley', last_name: 'Quinn' }),
      rosterRow({ first_name: 'Lee', last_name: 'Park' }),
      rosterRow({ first_name: 'Tamsin', last_name: 'Fenwick', active: false }),
    ];
    // Lee Park was taken off the app's roster: someone taken off is not in the app.
    const people = [ortiz, quinn, { ...park, active: false }];
    expect(notInApp(rows, people).map((r) => r.last_name)).toEqual(['Park']);
  });

  it('says where the two disagree on a role, and makes both the sign-in row’s', async () => {
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', role: 'supervisor' });
    expect(roleMismatch(row, ortiz)).toEqual({ line: 'Sign-in roster: Supervisor. In the app: Crew.', label: 'Make both supervisor' });
    expect(roleMismatch(rosterRow({ first_name: 'Riley J', last_name: 'Quinn' }), quinn)).toEqual({ line: 'Sign-in roster: Crew. In the app: Supervisor.', label: 'Make both crew' });
    expect(roleMismatch(ortizRow, ortiz)).toBeNull();
    expect(roleMismatch(ortizRow, undefined)).toBeNull();

    const w = writes();
    const told = await makeBoth(w.io, ortiz, 'supervisor');
    // Only the person is written: the sign-in row already says supervisor.
    expect(w.log).toEqual(['person emp_ortiz']);
    expect(w.saved).toEqual([{ ...ortiz, role: 'supervisor' }]);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is a supervisor in the app now. ${PEOPLE_SAVED}` });
  });
});

describe('adding people', () => {
  it('writes the sign-in row first, then a new person in the app under an id of their own, with no payroll ID', async () => {
    const plan = planAdd(both([quinn]), { firstName: 'Sam', lastName: 'Ortiz' });
    expect(plan).toEqual({ kind: 'new' });
    const w = writes();
    const told = await addPeople(w.io, both([quinn]), [{ firstName: 'Sam', lastName: 'Ortiz', title: 'Crusher', role: 'employee', plan }], ids('emp_new1'));
    expect(w.log).toEqual(['add rows Sam Ortiz', 'person emp_new1']);
    expect(w.saved).toEqual([{ id: 'emp_new1', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', title: 'Crusher', active: true }]);
    expect('payrollId' in w.saved[0]).toBe(false);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is on the roster. ${PEOPLE_SAVED}` });
  });

  it('writes a pasted list’s sign-in rows in one go, then each person', async () => {
    const w = writes();
    const list = [
      { firstName: 'Sam', lastName: 'Ortiz', role: 'employee' as const, plan: planAdd(both([]), { firstName: 'Sam', lastName: 'Ortiz' }) },
      { firstName: 'Lee', lastName: 'Park', role: 'supervisor' as const, plan: planAdd(both([]), { firstName: 'Lee', lastName: 'Park' }) },
    ];
    const told = await addPeople(w.io, both([]), list, ids('emp_1', 'emp_2'));
    expect(w.log).toEqual(['add rows Sam Ortiz, Lee Park', 'person emp_1', 'person emp_2']);
    expect(w.saved.map((p) => [p.id, p.role])).toEqual([['emp_1', 'employee'], ['emp_2', 'supervisor']]);
    expect(told).toEqual({ tone: 'ok', text: `2 people are on the roster. ${PEOPLE_SAVED}` });
  });

  it('writes nothing in the app when the sign-in roster does not take the rows, and says why', async () => {
    const w = writes({ rows: new Error('Adding the person did not work: that is already there. Reload the page.') });
    const told = await addPeople(w.io, both([]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'new' } }], ids('emp_new1'));
    expect(w.log).toEqual(['add rows Sam Ortiz']);
    expect(told).toEqual({ tone: 'bo', text: 'Adding the person did not work: that is already there. Reload the page.' });
  });

  it('says what is half done when the row is in and the person is not, with the button that finishes it', async () => {
    const w = writes({ person: () => ({ ok: false, changed: false, words: NO_SIGNAL }) });
    const told = await addPeople(w.io, both([]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'new' } }], ids('emp_new1'));
    expect(w.log).toEqual(['add rows Sam Ortiz', 'person emp_new1']);
    expect(told).toEqual({
      tone: 'warn',
      text: 'Sam Ortiz is on the sign-in roster but not in the app yet, so phones do not have them. Add them to the app’s roster to finish.',
      why: NO_SIGNAL,
      finish: { label: 'Add to the app’s roster', adds: [{ firstName: 'Sam', lastName: 'Ortiz' }] },
    });
    expect(ADD_TO_APP).toBe('Add to the app’s roster');
    expect(notInAppWords(['Sam Ortiz'])).toBe(told.text);
    expect(notInAppWords(['Sam Ortiz', 'Lee Park'])).toBe('Sam Ortiz and Lee Park are on the sign-in roster but not in the app yet, so phones do not have them. Add them to the app’s roster to finish.');

    // The row is now on the sign-in roster with nobody in the app for it; adding them to the app's roster writes only the person.
    expect(notInApp([ortizRow], [])).toEqual([ortizRow]);
    const again = writes();
    const finished = await addToApp(again.io, both([], [ortizRow]), ortizRow, planAdd(both([], [ortizRow]), { firstName: 'Sam', lastName: 'Ortiz' }, ortizRow.id), undefined, ids('emp_new2'));
    expect(again.log).toEqual(['person emp_new2']);
    expect(again.saved).toEqual([{ id: 'emp_new2', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', title: 'Crusher', active: true }]);
    expect(finished).toEqual({ tone: 'ok', text: `Sam Ortiz is on the app’s roster. ${PEOPLE_SAVED}` });
  });

  it('names everyone a list left half done', async () => {
    const w = writes({ person: (p) => (p.id === 'emp_1' ? undefined : { ok: false, changed: false, words: NO_SIGNAL }) });
    const list = ['Sam Ortiz', 'Lee Park', 'Dana Whitfield'].map((name) => {
      const [firstName, lastName] = name.split(' ');
      return { firstName, lastName, role: 'employee' as const, plan: { kind: 'new' as const } };
    });
    const told = await addPeople(w.io, both([]), list, ids('emp_1', 'emp_2', 'emp_3'));
    expect(w.log).toEqual(['add rows Sam Ortiz, Lee Park, Dana Whitfield', 'person emp_1', 'person emp_2', 'person emp_3']);
    expect(told).toMatchObject({ tone: 'warn', text: notInAppWords(['Lee Park', 'Dana Whitfield']), why: NO_SIGNAL });
    expect(told.finish?.adds.map((a) => a.lastName)).toEqual(['Park', 'Whitfield']);
  });

  it('puts only the row on the sign-in roster for someone already in the app, and says no phone has anything new', async () => {
    expect(planAdd(both([ortiz]), { firstName: 'sam', lastName: 'ortiz' })).toEqual({ kind: 'in_app', person: ortiz });
    // The way the mine writes a name, give or take a middle initial: the person the app has.
    expect(planAdd(both([quinn]), { firstName: 'Riley', lastName: 'Quinn' })).toEqual({ kind: 'in_app', person: quinn });
    const w = writes();
    const told = await addPeople(w.io, both([ortiz]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'in_app', person: ortiz } }], ids());
    expect(w.log).toEqual(['add rows Sam Ortiz']);
    // Only the sign-in row was written: "Phones get it" would not be true.
    expect(told).toEqual({ tone: 'ok', text: 'Sam Ortiz is on the roster. In the app already.' });
  });

  it('says whom the app has, when a name only fits them', async () => {
    const w = writes();
    const typed = { firstName: 'Riley', lastName: 'Quinn', role: 'employee' as const };
    const told = await addPeople(w.io, both([quinn]), [{ ...typed, plan: planAdd(both([quinn]), typed) }], ids());
    expect(w.log).toEqual(['add rows Riley Quinn']);
    expect(told).toEqual({ tone: 'ok', text: 'Riley Quinn is on the roster. In the app already as Riley J Quinn.' });
  });

  it('asks first when someone taken off the roster has the name: brought back, they keep their id, payroll ID and records', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false, payrollId: '1042', title: 'Crusher' });
    const plan = planAdd(both([off, park]), { firstName: 'Sam', lastName: 'Ortiz' });
    expect(plan).toEqual({ kind: 'ask', person: off });
    expect(takenOffQuestion(off)).toBe('Sam Ortiz, who was taken off the roster, has this name. Bring them back, or add a new person?');
    // A looser fit asks too: the app's roster has the middle initial.
    expect(planAdd(both([{ ...off, firstName: 'Sam J' }]), { firstName: 'Sam', lastName: 'Ortiz' })).toMatchObject({ kind: 'ask' });

    const back = writes();
    await addPeople(back.io, both([off, park]), [{ firstName: 'Sam', lastName: 'Ortiz', title: 'Plant lead', role: 'supervisor', plan, answer: 'back' }], ids('emp_unused'));
    expect(back.log).toEqual(['add rows Sam Ortiz', 'person emp_old']);
    expect(back.saved).toEqual([{ ...off, active: true, role: 'supervisor', title: 'Plant lead' }]);

    const fresh = writes();
    await addPeople(fresh.io, both([off, park]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan, answer: 'new' }], ids('emp_new'));
    expect(fresh.log).toEqual(['add rows Sam Ortiz', 'person emp_new']);
    expect(fresh.saved).toEqual([{ id: 'emp_new', firstName: 'Sam', lastName: 'Ortiz', role: 'employee', active: true }]);
  });

  it('writes nothing until the question is answered', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false });
    const w = writes();
    const told = await addPeople(w.io, both([off]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'ask', person: off } }], ids());
    expect(w.log).toEqual([]);
    expect(told).toEqual({ tone: 'bo', text: 'Answer the question about Sam Ortiz first: bring them back, or add a new person.' });
  });

  it('turns down a name two people in the app have, and writes nothing', async () => {
    const twin = person('emp_twin', 'Sam', 'Ortiz');
    const plan = planAdd(both([ortiz, twin]), { firstName: 'Sam', lastName: 'Ortiz' });
    expect(plan).toEqual({ kind: 'refused', text: 'Two people in the app are called Sam Ortiz. Take the one who should not be there off the app’s roster, beside the row, then try again.' });
    expect(twoPeopleWords('Sam Ortiz')).toBe(plan.kind === 'refused' ? plan.text : '');
    const w = writes();
    expect(await addPeople(w.io, both([ortiz, twin]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan }], ids())).toEqual({ tone: 'bo', text: twoPeopleWords('Sam Ortiz') });
    expect(w.log).toEqual([]);
  });

  it('adds someone under the id their hours already carry, when the sign-in roster named them before the app had them', async () => {
    // A page names a person from the sign-in row of the account that sent their hours, when no employee record has arrived.
    const named = person('emp_hours', 'Dana', 'Whitfield');
    const row = rosterRow({ first_name: 'Dana', last_name: 'Whitfield', user_id: 'user-whitfield' });
    const plan = planAdd(both([ortiz], [row], [named]), rowPerson(row), row.id);
    expect(plan).toEqual({ kind: 'new', id: 'emp_hours' });
    const w = writes();
    await addToApp(w.io, both([ortiz], [row], [named]), row, plan, undefined, ids('emp_unused'));
    expect(w.saved.map((p) => p.id)).toEqual(['emp_hours']);
  });

  it('keeps the hours’ id when someone taken off has the name and the answer is a new person', async () => {
    const off = person('emp_old', 'Dana', 'Whitfield', { active: false });
    const named = person('emp_hours', 'Dana', 'Whitfield');
    const row = rosterRow({ first_name: 'Dana', last_name: 'Whitfield', user_id: 'user-whitfield' });
    const plan = planAdd(both([off], [row], [named]), rowPerson(row), row.id);
    expect(plan).toEqual({ kind: 'ask', person: off, id: 'emp_hours' });
    const w = writes();
    await addToApp(w.io, both([off], [row], [named]), row, plan, 'new', ids('emp_fresh'));
    expect(w.saved.map((p) => p.id)).toEqual(['emp_hours']);
  });

  it('turns down a name the sign-in roster has already, as a pasted list passes it over, and writes nothing', async () => {
    const joined = { ...rosterRow({ first_name: 'Lee', last_name: 'Park' }), user_id: 'user-park' };
    // Typed again, a second row would make the name fit two rows: nobody could join under it, and taking one off would take Lee off the phones.
    expect(planAdd(both([park], [joined]), { firstName: 'lee', lastName: 'park' })).toEqual({ kind: 'refused', text: onRosterWords('Lee Park') });
    expect(onRosterWords('Lee Park')).toBe('Lee Park is on the sign-in roster already. To change them, use Change beside their name.');
    // A row taken off is put back on, with the person it was for, not typed again.
    const off = { ...joined, active: false };
    expect(planAdd(both([{ ...park, active: false }], [off]), { firstName: 'Lee', lastName: 'Park' })).toEqual({ kind: 'refused', text: offRosterWords('Lee Park') });
    // The writes hold it too: a plan made before the roster loaded again is turned down.
    const w = writes();
    const told = await addPeople(w.io, both([park], [joined]), [{ firstName: 'Lee', lastName: 'Park', role: 'employee', plan: { kind: 'in_app', person: park } }], ids());
    expect(told).toEqual({ tone: 'bo', text: onRosterWords('Lee Park') });
    expect(w.log).toEqual([]);
  });

  it('never gives a name that only fits someone the person another row names exactly', async () => {
    const son = person('emp_son', 'Sam', 'Ortiz Jr');
    const sonRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz Jr' });
    const fatherRow = rosterRow({ first_name: 'Sam', last_name: 'Ortiz' });
    // The father typed in is a new person: the son has his own row.
    expect(planAdd(both([son], [sonRow]), { firstName: 'Sam', lastName: 'Ortiz' })).toEqual({ kind: 'new' });
    // With the son's row alone on the roster, nobody else's, "Sam Ortiz" would fit him: that is still the app's rule.
    expect(planAdd(both([son]), { firstName: 'Sam', lastName: 'Ortiz' })).toEqual({ kind: 'in_app', person: son });
    // The father's row is not the son's: it is not in the app, and taking it off or changing it leaves the son alone.
    const rows = [sonRow, fatherRow];
    expect(notInApp(rows, [son]).map((r) => r.id)).toEqual([fatherRow.id]);
    const off = writes();
    await takeOff(off.io, both([son], rows), fatherRow, 'Sam Ortiz is off the roster.');
    expect(off.log).toEqual([`delete row ${fatherRow.id}`]);
    const role = writes();
    await changeRow(role.io, both([son], rows), fatherRow, { role: 'supervisor' }, 'Sam Ortiz is now a supervisor.');
    expect(role.log).toEqual([`update row ${fatherRow.id} {"role":"supervisor"}`]);
  });

  it('adds the same person once, under one id, however often it is pressed or tried again', async () => {
    const kept = ids('emp_1', 'emp_2');
    const typed = { firstName: 'Lee', lastName: 'Park', role: 'employee' as const };
    // The first try: the row went in, and the person's answer was lost.
    const lost = writes({ person: () => ({ ok: false, changed: false, words: NO_SIGNAL }) });
    await addPeople(lost.io, both([]), [{ ...typed, plan: planAdd(both([]), typed) }], kept);
    // Tried again from the row, before the page loaded the records again: the same id, so the same person.
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park' });
    const again = writes();
    await addToApp(again.io, both([], [row]), row, planAdd(both([], [row]), typed, row.id), undefined, kept);
    expect([...lost.saved, ...again.saved].map((p) => p.id)).toEqual(['emp_1']);
    expect(lost.log.concat(again.log).filter((l) => l.startsWith('person'))).toEqual(['person emp_1', 'person emp_1']);
    // Once saved, a new person of the name gets a new id.
    expect(kept.idFor(typed)).toBe('emp_2');
  });

  it('runs a button’s work once while it is under way', async () => {
    const only = oneAtATime();
    let runs = 0;
    let open!: () => void;
    const first = only(() => new Promise<string>((done) => {
      runs += 1;
      open = () => done('first');
    }));
    const second = await only(async () => {
      runs += 1;
      return 'second';
    });
    expect(second).toBeUndefined();
    open();
    expect(await first).toBe('first');
    expect(runs).toBe(1);
    expect(await only(async () => 'later')).toBe('later');
  });

  it('finishes a half-done addition from the app’s roster as it is now, with the answer given before', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false, title: 'Crusher' });
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz', title: 'Loader operator' });
    const w = writes();
    const told = await finishAdding(w.io, both([off], [row]), [{ firstName: 'Sam', lastName: 'Ortiz', answer: 'back' }], ids());
    expect(w.saved).toEqual([{ ...off, active: true, title: 'Loader operator' }]);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is on the app’s roster. ${PEOPLE_SAVED}` });
  });

  it('says why a person was not added beside a row that was, without saying nothing was saved', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false });
    const w = writes({ person: () => ({ ok: false, changed: true, words: 'changed', row: {} }) });
    const told = await addPeople(w.io, both([off]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'ask', person: off }, answer: 'back' }], ids());
    expect(told.text).toBe(notInAppWords(['Sam Ortiz']));
    expect(told.why).toBe('Someone else changed Sam Ortiz since this page loaded it. Load new records and look again.');
    expect(`${told.text} ${told.why}`).not.toMatch(/Nothing was saved/);
    // The billing words start with it.
    expect(halfWhy('Nothing was saved: the company’s MineMuster subscription has ended. Open Billing to start it again.')).toBe('The company’s MineMuster subscription has ended. Open Billing to start it again.');
  });

  it('brings someone back with the row’s job title, none included', async () => {
    const off = person('emp_old', 'Lee', 'Park', { active: false, title: 'Crusher' });
    const w = writes();
    await addPeople(w.io, both([off]), [{ firstName: 'Lee', lastName: 'Park', role: 'employee', plan: { kind: 'ask', person: off }, answer: 'back' }], ids());
    expect(w.saved).toHaveLength(1);
    expect('title' in w.saved[0]).toBe(false);
  });
});

describe('letting a request in on a new row', () => {
  const row = { ...rosterRow({ first_name: 'Lee', last_name: 'Park' }), user_id: 'user-park', claimed_at: '2026-11-20T15:00:00.000Z' };

  it('writes the person in the app after the row the server made, as any addition does', async () => {
    const w = writes();
    const told = await letInOnNewRow(w.io, both([ortiz], [ortizRow, row]), row, ids('emp_park'));
    expect(w.saved).toEqual([{ id: 'emp_park', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }]);
    expect(told).toEqual({ tone: 'ok', text: `Lee Park is let in, and on the app’s roster. ${PEOPLE_SAVED}` });
  });

  it('says it is half done, and how to finish, when the person cannot be written now', async () => {
    const off = person('emp_old', 'Lee', 'Park', { active: false });
    const w = writes();
    const asked = await letInOnNewRow(w.io, both([off], [row]), row, ids());
    expect(w.log).toEqual([]);
    expect(asked).toEqual({
      tone: 'warn',
      text: `Lee Park is let in. ${notInAppWords(['Lee Park'])}`,
      why: 'Lee Park, who was taken off the roster, has this name, so the page asks first: use Add to the app’s roster under On the sign-in roster, not in the app.',
    });
    const blind = await letInOnNewRow(w.io, null, row, ids());
    expect(blind).toMatchObject({ tone: 'warn', text: `Lee Park is let in. ${notInAppWords(['Lee Park'])}` });
    const failing = writes({ person: () => ({ ok: false, changed: false, words: NO_SIGNAL }) });
    expect(await letInOnNewRow(failing.io, both([], [row]), row, ids('emp_park'))).toMatchObject({
      tone: 'warn',
      text: `Lee Park is let in. ${notInAppWords(['Lee Park'])}`,
      why: NO_SIGNAL,
      finish: { label: ADD_TO_APP, adds: [{ firstName: 'Lee', lastName: 'Park' }] },
    });
  });
});

describe('changing a row', () => {
  it('writes the person first, from the version the page loaded, then the row', async () => {
    const w = writes();
    const told = await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { role: 'supervisor' }, 'Sam Ortiz is now a supervisor.');
    expect(w.log).toEqual(['person emp_ortiz', `update row ${ortizRow.id} {"role":"supervisor"}`]);
    expect(w.saved).toEqual([{ ...ortiz, role: 'supervisor' }]);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is now a supervisor. ${PEOPLE_SAVED}` });
  });

  it('saves nothing when someone else changed the person since the page loaded them', async () => {
    const w = writes({ person: () => ({ ok: false, changed: true, words: 'Sam Ortiz was changed after this page loaded it.', row: {} }) });
    const told = await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { title: 'Loader operator' }, 'Saved.');
    expect(w.log).toEqual(['person emp_ortiz']);
    expect(told).toEqual({ tone: 'warn', text: 'Someone else changed Sam Ortiz since this page loaded it. Nothing was saved. Load new records and look again.' });
    expect(personRefusedWords('Sam Ortiz')).toBe(told.text);
  });

  it('says the server’s own reason when it turned the person down for another', async () => {
    const words = 'Only a supervisor of the company can change Sam Ortiz, and the server says this account is not one now. Nothing was saved. Sign out and back in if your role changed, or ask another supervisor.';
    const w = writes({ person: () => ({ ok: false, changed: false, words }) });
    expect(await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { role: 'supervisor' }, '')).toEqual({ tone: 'bo', text: words });
    expect(w.log).toEqual(['person emp_ortiz']);
  });

  it('says what is half done when the person is saved and the row is not', async () => {
    const w = writes({ update: new Error(NO_SIGNAL) });
    expect(await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { role: 'supervisor' }, '')).toEqual({ tone: 'warn', text: 'Sam Ortiz’s role is changed in the app but not on the sign-in roster. Change it again to finish.', why: NO_SIGNAL });
    expect(await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { title: 'Loader operator' }, '')).toEqual({ tone: 'warn', text: rowNotChangedWords('Sam Ortiz', 'title'), why: NO_SIGNAL });
    expect(rowNotChangedWords('Sam Ortiz', 'title')).toBe('Sam Ortiz’s job title is changed in the app but not on the sign-in roster. Change it again to finish.');
  });

  it('writes only the row when nobody in the app is the row’s, or the person already says so, and never says phones get it', async () => {
    const w = writes();
    const nobody = await changeRow(w.io, both([], [ortizRow]), ortizRow, { role: 'supervisor' }, 'Sam Ortiz is now a supervisor.');
    const already = await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { title: 'Crusher' }, 'Sam Ortiz’s job title is Crusher now.');
    expect(w.log).toEqual([`update row ${ortizRow.id} {"role":"supervisor"}`, `update row ${ortizRow.id} {"title":"Crusher"}`]);
    expect(nobody).toEqual({ tone: 'ok', text: 'Sam Ortiz is now a supervisor.' });
    expect(already).toEqual({ tone: 'ok', text: 'Sam Ortiz’s job title is Crusher now.' });
    // With nothing written to the person, a row that fails is not half done: nothing was saved.
    const failing = writes({ update: new Error(NO_SIGNAL) });
    expect(await changeRow(failing.io, both([], [ortizRow]), ortizRow, { role: 'supervisor' }, '')).toEqual({ tone: 'bo', text: NO_SIGNAL });
  });

  it('takes the job title off the person when it is taken off the row', async () => {
    const w = writes();
    await changeRow(w.io, both([ortiz], [ortizRow]), ortizRow, { title: null }, 'Done.');
    expect(w.saved).toHaveLength(1);
    expect('title' in w.saved[0]).toBe(false);
  });

  it('brings back the person taken off who fits a row put back on, with the row’s role and title, person first', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false, payrollId: '1042' });
    const row = { ...ortizRow, active: false, role: 'supervisor' as const };
    const w = writes();
    const told = await changeRow(w.io, both([off], [row]), row, { active: true }, 'Sam Ortiz is back on the roster.');
    expect(w.log).toEqual(['person emp_old', `update row ${row.id} {"active":true}`]);
    expect(w.saved).toEqual([{ ...off, active: true, role: 'supervisor', title: 'Crusher' }]);
    expect(told.tone).toBe('ok');
    const failing = writes({ update: new Error(NO_SIGNAL) });
    expect(await changeRow(failing.io, both([off], [row]), row, { active: true }, '')).toEqual({
      tone: 'warn',
      text: 'Sam Ortiz is back on the app’s roster but not on the sign-in roster. Put them back on again to finish.',
      why: NO_SIGNAL,
    });
  });

  it('puts the row’s job title on someone brought back, none included', async () => {
    const off = person('emp_old', 'Lee', 'Park', { active: false, title: 'Crusher' });
    const row = { ...rosterRow({ first_name: 'Lee', last_name: 'Park' }), active: false, user_id: 'user-park' };
    const w = writes();
    await changeRow(w.io, both([off], [row]), row, { active: true }, 'Lee Park is back on the roster.');
    expect(w.saved).toHaveLength(1);
    expect('title' in w.saved[0]).toBe(false);
  });

  it('changes nobody in the app for a row two people in the app are called by', async () => {
    const twin = person('emp_twin', 'Sam', 'Ortiz');
    const w = writes();
    expect(await changeRow(w.io, both([ortiz, twin], [ortizRow]), ortizRow, { title: 'Loader operator' }, 'Done.')).toEqual({ tone: 'bo', text: twoPeopleWords('Sam Ortiz') });
    expect(await changeRow(w.io, both([ortiz, twin], [ortizRow]), ortizRow, { role: 'supervisor' }, 'Done.')).toEqual({ tone: 'bo', text: twoPeopleWords('Sam Ortiz') });
    expect(w.log).toEqual([]);
    // Made crew, the sign-in loses a supervisor's powers at once all the same; the app's roster is not changed.
    const crew = writes();
    const row = { ...ortizRow, role: 'supervisor' as const };
    expect(await changeRow(crew.io, both([ortiz, twin], [row]), row, { role: 'employee' }, 'Sam Ortiz is now crew.')).toEqual({ tone: 'warn', text: `Sam Ortiz is now crew. ${twoNotChangedWords('Sam Ortiz')}` });
    expect(crew.log).toEqual([`update row ${row.id} {"role":"employee"}`]);
  });

  it('makes a supervisor crew on the sign-in roster alone while the app’s roster is not loaded, and nothing else', async () => {
    const row = { ...ortizRow, role: 'supervisor' as const };
    const w = writes();
    expect(await changeRow(w.io, null, row, { role: 'employee' }, 'Sam Ortiz is now crew.')).toEqual({ tone: 'warn', text: `Sam Ortiz is now crew. ${notLoadedCrewWords('Sam Ortiz')}` });
    expect(w.log).toEqual([`update row ${row.id} {"role":"employee"}`]);
    expect(notLoadedCrewWords('Sam Ortiz')).toBe('The app’s roster is not loaded, so it was not changed. Once the records load, look at Sam Ortiz there: if the app still has them as a supervisor, Make both crew shows beside their name.');
    for (const patch of [{ role: 'supervisor' as const }, { title: 'Crusher' }, { active: true }]) {
      expect(await changeRow(w.io, null, row, patch, 'Done.')).toEqual(PEOPLE_NOT_LOADED);
    }
    expect(w.log).toHaveLength(1);
  });
});

describe('taking someone off', () => {
  it('takes the person off the app’s roster first, never deleting them, then removes the row', async () => {
    const w = writes();
    const told = await takeOff(w.io, both([ortiz], [ortizRow]), ortizRow, 'Sam Ortiz is off the roster.');
    expect(w.log).toEqual(['person emp_ortiz', `delete row ${ortizRow.id}`]);
    expect(w.saved).toEqual([{ ...ortiz, active: false }]);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is off the roster. ${PEOPLE_SAVED}` });
  });

  it('switches a row someone joined on off instead of removing it, the person first', async () => {
    const joined = { ...ortizRow, user_id: 'user-ortiz', claimed_at: '2026-11-02T15:00:00.000Z' };
    const w = writes();
    await takeOff(w.io, both([ortiz], [joined]), joined, 'Done.');
    expect(w.log).toEqual(['person emp_ortiz', `update row ${joined.id} {"active":false}`]);
  });

  it('saves nothing when the person is turned down, and says so', async () => {
    const w = writes({ person: () => ({ ok: false, changed: true, words: 'changed', row: {} }) });
    expect(await takeOff(w.io, both([ortiz], [ortizRow]), ortizRow, 'Done.')).toEqual({ tone: 'warn', text: personRefusedWords('Sam Ortiz') });
    expect(w.log).toEqual(['person emp_ortiz']);
  });

  it('says what is half done when the person is off and the row is not', async () => {
    const w = writes({ remove: new Error(NO_SIGNAL) });
    const told = await takeOff(w.io, both([ortiz], [ortizRow]), ortizRow, 'Done.');
    expect(told).toEqual({
      tone: 'warn',
      text: 'Sam Ortiz is off the app’s roster but still on the sign-in roster, so their sign-in still reads the company’s records. Remove the row again to finish.',
      why: NO_SIGNAL,
    });
    expect(rowStillOnWords('Sam Ortiz')).toBe(told.text);
  });

  it('removes only the row when nobody in the app is the row’s, and does not say phones get it', async () => {
    const w = writes();
    expect(await takeOff(w.io, both([], [ortizRow]), ortizRow, 'Sam Ortiz is off the roster.')).toEqual({ tone: 'ok', text: 'Sam Ortiz is off the roster.' });
    expect(w.log).toEqual([`delete row ${ortizRow.id}`]);
  });

  it('leaves the person in the app when another row is theirs too', async () => {
    const joined = { ...ortizRow, id: 'row-joined', user_id: 'user-ortiz' };
    const second = { ...ortizRow, id: 'row-second' };
    const w = writes();
    const told = await takeOff(w.io, both([ortiz], [joined, second]), second, 'Sam Ortiz is off the roster.');
    expect(w.log).toEqual(['delete row row-second']);
    expect(told).toEqual({ tone: 'ok', text: `Sam Ortiz is off the roster. ${sharedRowWords('Sam Ortiz')}` });
  });

  it('never picks one of two people in the app called by the row: the row goes, and the app’s roster is not changed', async () => {
    const a = person('emp_a', 'Lee', 'Park');
    const b = person('emp_b', 'Lee', 'Park');
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park' });
    const w = writes();
    expect(await takeOff(w.io, both([a, b], [row]), row, 'Lee Park is off the roster.')).toEqual({ tone: 'warn', text: `Lee Park is off the roster. ${twoNotChangedWords('Lee Park')}` });
    expect(w.log).toEqual([`delete row ${row.id}`]);
  });

  it('takes the sign-in off while the app’s roster is not loaded, and says the person is still in the app', async () => {
    const joined = { ...ortizRow, user_id: 'user-ortiz' };
    const w = writes();
    expect(await takeOff(w.io, null, joined, 'Sam Ortiz is off the roster.')).toEqual({ tone: 'warn', text: `Sam Ortiz is off the roster. ${notLoadedOffWords('Sam Ortiz')}` });
    expect(w.log).toEqual([`update row ${joined.id} {"active":false}`]);
  });

  it('takes someone off the app’s roster alone, never deleting them', async () => {
    const w = writes();
    expect(await takeOffApp(w.io, ortiz)).toEqual({ tone: 'ok', text: `Sam Ortiz is off the app’s roster. ${PEOPLE_SAVED}` });
    expect(w.saved).toEqual([{ ...ortiz, active: false }]);
    const refused = writes({ person: () => ({ ok: false, changed: true, words: 'changed', row: {} }) });
    expect(await takeOffApp(refused.io, ortiz)).toEqual({ tone: 'warn', text: personRefusedWords('Sam Ortiz') });
  });

  it('asks first when the person is on the clock, as far as their phone has sent', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
    const shift = (id: string, employeeId: string, clockIn: number, clockOut?: number): Shift => ({
      id, employeeId, clockIn: { at: clockIn }, ...(clockOut ? { clockOut: { at: clockOut } } : null), lunches: [], breaks: [],
    });
    const now = at(14, 30);
    const shifts = [shift('s1', 'emp_ortiz', at(6, 2) - 86_400_000, at(16) - 86_400_000), shift('s2', 'emp_ortiz', at(6, 2)), shift('s3', 'emp_park', at(5))];
    expect(onTheClock('emp_ortiz', shifts, now, PIT)).toBe(at(6, 2));
    // Their newest shift is the one that counts: clocked out, they are not on the clock.
    expect(onTheClock('emp_ortiz', [...shifts, shift('s4', 'emp_ortiz', at(7), at(12))], now, PIT)).toBeNull();
    // A shift left open as long as the company's rules give a clock-out (16 hours) is a clock-out the phone never sent, not someone at work.
    expect(onTheClock('emp_ortiz', shifts, at(6, 2) + 16 * 3_600_000, PIT)).toBeNull();
    expect(onTheClock('emp_ortiz', shifts, at(6, 2) + 16 * 3_600_000, { ...PIT, state: 'CA' })).toBeNull();
    expect(onTheClock('emp_quinn', shifts, now, PIT)).toBeNull();
    // A clock-in after the page last read the time counts: a phone's clock runs a little ahead.
    expect(onTheClock('emp_new', [shift('s5', 'emp_new', now + 30_000)], now, PIT)).toBe(now + 30_000);
    // A company that keeps no time has nobody on the clock, whatever a phone sent before the clock was turned off.
    expect(onTheClock('emp_ortiz', shifts, now, { ...PIT, timeClock: false })).toBeNull();

    expect(clockQuestion('Sam Ortiz', at(6, 2))).toBe('Sam Ortiz is on the clock since Nov 20, 6:02 AM, as far as their phone has sent. Their clock-out reaches the company only while they are on the roster. Take them off after their shift?');
    expect(CLOCK_ANSWERS).toEqual({ yes: 'Take off now', no: 'Cancel' });
  });
});

describe('payroll IDs', () => {
  it('saves a person’s payroll ID through their record, trimmed', async () => {
    const w = writes();
    const told = await savePayrollId(w.io, [ortiz, quinn], ortiz, ' 1042 ');
    expect(w.saved).toEqual([{ ...ortiz, payrollId: '1042' }]);
    expect(told).toEqual({ tone: 'ok', text: 'Payroll ID 1042 is saved for Sam Ortiz. Supervisors’ phones get it the next time they are open with signal; crew phones never hold payroll IDs.' });
  });

  it('takes one off when it is left empty', async () => {
    const w = writes();
    const told = await savePayrollId(w.io, [quinn], quinn, '  ');
    expect(w.saved).toHaveLength(1);
    expect('payrollId' in w.saved[0]).toBe(false);
    expect(told.text).toBe('Riley J Quinn has no payroll ID now. Supervisors’ phones get it the next time they are open with signal; crew phones never hold payroll IDs.');
  });

  it('says what is wrong with one in the app’s own words, and writes nothing', async () => {
    const w = writes();
    expect(await savePayrollId(w.io, [ortiz, quinn], ortiz, '2001')).toEqual({ tone: 'bo', text: 'Riley J Quinn already has payroll ID 2001.' });
    expect(await savePayrollId(w.io, [ortiz, quinn], ortiz, '#1042')).toEqual({ tone: 'bo', text: 'A payroll ID is up to 20 letters and numbers. A dash, dot, slash or space between them is fine.' });
    // Someone taken off the roster still holds theirs.
    expect(await savePayrollId(w.io, [ortiz, { ...park, active: false, payrollId: '3003' }], ortiz, '3003')).toEqual({ tone: 'bo', text: 'Lee Park already has payroll ID 3003.' });
    expect(w.log).toEqual([]);
  });

  it('says why when the server turned it down', async () => {
    const w = writes({ person: () => ({ ok: false, changed: true, words: 'changed', row: {} }) });
    expect(await savePayrollId(w.io, [ortiz], ortiz, '1042')).toEqual({ tone: 'warn', text: personRefusedWords('Sam Ortiz') });
  });
});

describe('the loose ends of the final check', () => {
  it('turns down the full name of someone a looser row is for already: a second row would take them from it', () => {
    // Riley J Quinn joined on a row written "Riley Quinn": that row is theirs, as a phone matches it.
    const row = rosterRow({ first_name: 'Riley', last_name: 'Quinn', user_id: 'user-quinn' });
    expect(planAdd(both([quinn], [row]), { firstName: 'Riley J', lastName: 'Quinn' })).toEqual({ kind: 'refused', text: onRosterAsWords('Riley J Quinn', 'Riley Quinn') });
    expect(onRosterAsWords('Riley J Quinn', 'Riley Quinn')).toBe('Riley J Quinn is on the sign-in roster already, as Riley Quinn. To change them, use Change beside that name.');
    // A name that only fits someone with a row of their own is someone else: the father beside the son is a new person.
    expect(planAdd(both([quinn], [rosterRow({ first_name: 'Riley J', last_name: 'Quinn' })]), { firstName: 'Riley', lastName: 'Quinn' })).toEqual({ kind: 'new' });
  });

  it('points a name typed again after a half-done addition to the button that finishes it', async () => {
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park' });
    expect(planAdd(both([ortiz], [row]), { firstName: 'Lee', lastName: 'Park' })).toEqual({ kind: 'refused', text: notInAppYetWords('Lee Park') });
    expect(notInAppYetWords('Lee Park')).toBe('Lee Park is on the sign-in roster already, but not in the app yet: use Add to the app’s roster under On the sign-in roster, not in the app.');
    const w = writes();
    expect(await addPeople(w.io, both([ortiz], [row]), [{ firstName: 'Lee', lastName: 'Park', role: 'employee', plan: { kind: 'new' } }], ids())).toEqual({ tone: 'bo', text: notInAppYetWords('Lee Park') });
    expect(w.log).toEqual([]);
  });

  it('picks neither of two people taken off the roster with the name, and says so', async () => {
    const a = person('emp_a', 'Lee', 'Park', { active: false });
    const b = person('emp_b', 'Lee', 'Park', { active: false });
    expect(planAdd(both([a, b]), { firstName: 'Lee', lastName: 'Park' })).toEqual({ kind: 'refused', text: twoOffWords('Lee Park') });
    const row = rosterRow({ first_name: 'Lee', last_name: 'Park', active: false });
    const w = writes();
    expect(await changeRow(w.io, both([a, b], [row]), row, { active: true }, 'Lee Park is back on the roster.')).toEqual({ tone: 'bo', text: twoOffWords('Lee Park') });
    expect(w.log).toEqual([]);
    expect(twoOffWords('Lee Park')).toBe('Two people taken off the roster are called Lee Park, so the page cannot tell which one this is. Add them again with their full name, middle initial included.');
  });

  it('brings someone back on their own row when it was taken off, so the account that joined on it works again', async () => {
    const off = person('emp_quinn', 'Riley J', 'Quinn', { active: false, payrollId: '2001' });
    const theirs = rosterRow({ first_name: 'Riley J', last_name: 'Quinn', active: false, user_id: 'user-quinn' });
    const typed = { firstName: 'Riley', lastName: 'Quinn', role: 'employee' as const };
    const plan = planAdd(both([off], [theirs]), typed);
    expect(plan).toEqual({ kind: 'ask', person: off });
    const w = writes();
    const told = await addPeople(w.io, both([off], [theirs]), [{ ...typed, plan, answer: 'back' }], ids());
    // Their own row goes back on, then the person: no second row.
    expect(w.log).toEqual([`update row ${theirs.id} {"active":true,"role":"employee","title":null}`, 'person emp_quinn']);
    expect(w.saved).toEqual([{ ...off, active: true, role: 'employee' }]);
    expect(told).toEqual({ tone: 'ok', text: `Riley J Quinn is back on the roster. ${PEOPLE_SAVED}` });
  });

  it('offers no finish button after a save the server took as this account’s own repeat', async () => {
    const off = person('emp_old', 'Sam', 'Ortiz', { active: false });
    const repeat = 'The server took this for the change this account made to Sam Ortiz before, which someone else has since put back, and kept the version it holds. Nothing was saved. Another supervisor can make the change from their own account.';
    const w = writes({ person: () => ({ ok: false, changed: false, words: repeat, repeat: true }) });
    const told = await addPeople(w.io, both([off]), [{ firstName: 'Sam', lastName: 'Ortiz', role: 'employee', plan: { kind: 'ask', person: off }, answer: 'back' }], ids());
    expect(told.finish).toBeUndefined();
    expect(told.text).toBe(notInAppWords(['Sam Ortiz'], false));
    expect(told.text).not.toMatch(/to finish/);
    expect(told.why).toMatch(/Another supervisor can make the change/);
  });

  it('says nothing is saved when finishing finds the person in the app already, and says who is no longer on the sign-in roster', async () => {
    const row = rosterRow({ first_name: 'Sam', last_name: 'Ortiz' });
    const w = writes();
    expect(await finishAdding(w.io, both([ortiz], [row]), [{ firstName: 'Sam', lastName: 'Ortiz' }], ids())).toEqual({ tone: 'ok', text: inAppAlready(rowPerson(row), ortiz) });
    expect(inAppAlready(rowPerson(row), ortiz)).toBe('Sam Ortiz is in the app already.');
    expect(await finishAdding(w.io, both([ortiz], []), [{ firstName: 'Lee', lastName: 'Park' }], ids())).toEqual({ tone: 'warn', text: notOnRosterNowWords(['Lee Park']) });
    expect(notOnRosterNowWords(['Lee Park'])).toBe('Lee Park is not on the sign-in roster now, so they were not added to the app’s roster. Load new records, then add them again.');
    expect(w.log).toEqual([]);
  });

  it('says the app’s roster was not changed while it was not loaded, without guessing what it holds', () => {
    expect(notLoadedOffWords('Sam Ortiz')).toBe(
      'The app’s roster is not loaded, so it was not changed. Once the records load, look for Sam Ortiz below the sign-in roster: anyone still on the app’s roster is listed there, with Take off the app’s roster.',
    );
  });
});
