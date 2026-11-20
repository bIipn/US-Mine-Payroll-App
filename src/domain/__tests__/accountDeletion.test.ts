import {
  ACCOUNT_PAGE,
  DELETED_TOAST,
  deletionPlan,
  moreRowWords,
  offRosterWords,
  whoseSignIn,
  type DeletionCheckCompany,
  type DeletionInput,
} from '../accountDeletion';
import { LUNCH_MS } from '../time';
import type { Employee, Shift } from '../types';

// Made-up people and companies: no real person, no real mine.
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const RILEY: Employee = { id: 'emp-riley', firstName: 'Riley J', lastName: 'Quinn', role: 'employee', active: true };
const SAM: Employee = { id: 'emp-sam', firstName: 'Sam', lastName: 'Ortiz', role: 'supervisor', active: true };
const PIT = { id: 'c-a', name: 'Test Pit A', role: 'employee' as const, userId: 'u-riley', email: 'riley@example.com' };
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A phone that never joined a company, in a build that can: Riley signed in to the app alone. */
function input(over: Partial<DeletionInput> = {}): DeletionInput {
  return {
    now: NOW,
    me: RILEY,
    account: { email: 'riley@example.com', passwordHash: 'h' },
    sample: false,
    keepsTime: true,
    company: 'Test Pit A',
    hasRate: true,
    canConnect: true,
    linked: null,
    standing: null,
    serverAccount: null,
    otherAccounts: 0,
    othersOnClock: 0,
    sync: { online: true, waiting: 0, notTaken: 0, stuck: 0 },
    check: 'unknown',
    fmtTime: hhmm,
    fmtDay: day,
    ...over,
  };
}
/** Riley's own phone, joined with Riley's own company sign-in. */
const ownPhone = (over: Partial<DeletionInput> = {}) =>
  input({
    linked: PIT,
    standing: { role: 'employee', name: { firstName: 'Riley J', lastName: 'Quinn' } },
    serverAccount: { id: 'u-riley', email: 'riley@example.com' },
    check: [{ id: 'c-a', name: 'Test Pit A', role: 'employee', lastSupervisor: false, successors: [], running: null }],
    ...over,
  });
const kinds = (plan: ReturnType<typeof deletionPlan>) => plan.blockers.map((b) => b.kind);
const shiftAt = (at: number, extra: Partial<Shift> = {}): Shift => ({ id: 'sh-1', employeeId: RILEY.id, clockIn: { at }, lunches: [], breaks: [], ...extra });

describe('whose company sign-in is deleted with the account', () => {
  it('is theirs when the phone sends with it and the company says it is theirs, or when the phone joined nothing', () => {
    expect(whoseSignIn(ownPhone())).toEqual({ kind: 'theirs', email: 'riley@example.com', connected: true });
    expect(whoseSignIn(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' } }))).toEqual({ kind: 'theirs', email: 'riley@example.com', connected: false });
  });

  it('is someone else’s on a phone joined with another person’s sign-in, and is never touched', () => {
    const shared = ownPhone({ standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, serverAccount: { id: 'u-sam', email: 'sam@example.com' } });
    expect(whoseSignIn(shared)).toEqual({ kind: 'someone_else', name: 'Sam Ortiz' });
  });

  it('is theirs but signed out when the phone’s own sign-in is not the one signed in now', () => {
    expect(whoseSignIn(ownPhone({ serverAccount: null }))).toEqual({ kind: 'theirs_signed_out', email: 'riley@example.com' });
  });

  it('is not known yet before the phone has heard from the company, and there is none in a build with no server', () => {
    expect(whoseSignIn(ownPhone({ standing: { role: null, name: null } }))).toEqual({ kind: 'unknown' });
    expect(whoseSignIn(ownPhone({ serverAccount: undefined }))).toEqual({ kind: 'unknown' });
    expect(whoseSignIn(input({ canConnect: false, serverAccount: { id: 'u', email: 'x@example.com' } }))).toEqual({ kind: 'none' });
    expect(whoseSignIn(input())).toEqual({ kind: 'none' });
  });
});

describe('deleting an account kept on this phone alone', () => {
  it('deletes the sign-in and the rate, keeps the records with the company, and needs no password', () => {
    const plan = deletionPlan(input({ canConnect: false }));
    expect(plan.title).toBe('Delete my account');
    expect(plan.intro).toBe('Deleting your account takes your sign-in off this phone. It cannot be undone.');
    expect(plan.serverToo).toBe(false);
    expect(plan.needsPassword).toBe(false);
    expect(plan.blockers).toEqual([]);
    expect(plan.deletes).toEqual(['Your sign-in on this phone, riley@example.com, and its password.', 'Your hourly rate, kept only on this phone.']);
    expect(plan.keeps).toEqual([
      'Your name on Test Pit A’s roster. A supervisor takes it off when you leave.',
      'Your punches, paid leave, equipment checklists, pre shift exams and maintenance requests, with your name on them.',
    ]);
    expect(plan.phone).toEqual(['Your records stay on this phone. They are Test Pit A’s; a supervisor clears them from the phone. Deleting the app removes everything it keeps on this phone.']);
    expect(plan.clearsPhone).toBe(false);
    // A build with no server names none: nothing about another phone's company sign-in.
    expect(plan.phone.join(' ')).not.toMatch(/app\.minemuster\.com/);
  });

  it('says where a company sign-in elsewhere is deleted, in a build that has one', () => {
    const plan = deletionPlan(input());
    expect(plan.phone).toContain('If you have a company sign-in on another phone, delete it there, or at app.minemuster.com/account.');
    expect(ACCOUNT_PAGE).toBe('https://app.minemuster.com/account');
  });

  it('claims to delete no rate it does not have, and no password for an account made without one', () => {
    const plan = deletionPlan(input({ hasRate: false, account: { email: 'riley@example.com' } }));
    expect(plan.deletes).toEqual(['Your sign-in on this phone, riley@example.com.']);
  });

  it('says why the company keeps its records, citing only the standard that was checked', () => {
    const time = deletionPlan(input()).legal;
    expect(time).toBe(
      'They are Test Pit A’s records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it, and the time and pay records the law has the company keep. A plain-language summary, not legal advice.',
    );
    const safety = deletionPlan(input({ keepsTime: false })).legal;
    expect(safety).toBe('They are Test Pit A’s records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it. A plain-language summary, not legal advice.');
    for (const words of [time, safety]) expect(words).not.toMatch(/516|1174|Labor Code/);
  });

  it('leaves time and pay out of every line for a company that runs the safety forms alone', () => {
    const plan = deletionPlan(input({ keepsTime: false, hasRate: false }));
    expect(plan.keeps[1]).toBe('Your equipment checklists, pre shift exams and maintenance requests, with your name on them.');
    expect([...plan.deletes, ...plan.keeps, plan.legal].join(' ')).not.toMatch(/punch|paid leave|hourly rate|time and pay/i);
  });
});

describe('deleting with their own company sign-in', () => {
  it('deletes the company sign-in too, after the password, and clears the phone when nothing would be lost', () => {
    const plan = deletionPlan(ownPhone());
    expect(plan.serverToo).toBe(true);
    expect(plan.needsPassword).toBe(true);
    expect(plan.passwordLabel).toBe('Password for riley@example.com');
    expect(plan.intro).toBe('Deleting your account takes your sign-in off this phone and off MineMuster’s server. It cannot be undone.');
    expect(plan.deletes).toEqual([
      'Your sign-in on this phone, riley@example.com, and its password.',
      'Your hourly rate, kept only on this phone.',
      'Your company sign-in, riley@example.com, on MineMuster’s server. It stops working on every phone and on the office dashboard.',
      'Your requests to join a company.',
    ]);
    expect(plan.keeps).toContain('MineMuster keeps them for Test Pit A while it uses MineMuster, and deletes them when the company asks.');
    expect(plan.clearsPhone).toBe(true);
    expect(plan.phone).toEqual(['Everything on this phone has reached Test Pit A, so the phone is cleared too and goes back to how the app starts.']);
    expect(plan.blockers).toEqual([]);
  });

  it('clears no phone that others sign in to, or that holds anything the company does not have', () => {
    for (const over of [{ otherAccounts: 1 }, { sync: { online: true, waiting: 0, notTaken: 2, stuck: 0 } }, { sync: { online: true, waiting: 0, notTaken: 0, stuck: 1 } }]) {
      expect(deletionPlan(ownPhone(over)).clearsPhone).toBe(false);
    }
    const shared = deletionPlan(ownPhone({ otherAccounts: 2, othersOnClock: 3 }));
    expect(shared.phone).toEqual([
      'This phone sends Test Pit A’s records with your company sign-in, the crew’s included. Once it is deleted, the phone stops sending until it is joined again with another sign-in.',
      '3 people are on the clock on this phone. Their punches wait on the phone until then.',
      'Your records stay on this phone. They are Test Pit A’s; a supervisor clears them from the phone.',
    ]);
    expect(deletionPlan(ownPhone({ otherAccounts: 1, othersOnClock: 1 })).phone[1]).toBe('1 person is on the clock on this phone. Their punches wait on the phone until then.');
  });

  it('waits for the records to reach the company first, and says it needs signal', () => {
    const waiting = deletionPlan(ownPhone({ sync: { online: true, waiting: 4, notTaken: 0, stuck: 0 } }));
    expect(waiting.blockers).toEqual([
      { kind: 'waiting', title: '4 records have not reached Test Pit A yet', body: 'They are sent before your company sign-in is deleted, so the company has them.', action: 'send' },
    ]);
    const one = deletionPlan(ownPhone({ sync: { online: false, waiting: 1, notTaken: 0, stuck: 0 } }));
    expect(one.blockers).toEqual([
      { kind: 'waiting', title: '1 record has not reached Test Pit A yet', body: 'They are sent before your company sign-in is deleted, so the company has them. This needs signal.', action: 'send' },
    ]);
  });

  it('needs signal, and says nothing has been deleted', () => {
    const plan = deletionPlan(ownPhone({ sync: { online: false, waiting: 0, notTaken: 0, stuck: 0 } }));
    expect(plan.blockers).toEqual([
      { kind: 'no_signal', title: 'This needs signal', body: 'Deleting your company sign-in is done on MineMuster’s server. Try again when you have signal. Nothing has been deleted.' },
    ]);
    // A phone that never joined needs it too, to delete the company sign-in it is signed in with.
    expect(kinds(deletionPlan(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' }, sync: { online: false, waiting: 0, notTaken: 0, stuck: 0 } })))).toEqual(['no_signal']);
  });

  it('waits while the server is asked, and while the phone has not heard who its sign-in is', () => {
    expect(deletionPlan(ownPhone({ check: 'checking' })).blockers).toEqual([{ kind: 'checking', title: 'Checking your account with MineMuster’s server…', body: '' }]);
    expect(kinds(deletionPlan(ownPhone({ standing: { role: null, name: null } })))).toEqual(['checking']);
    expect(kinds(deletionPlan(ownPhone({ standing: { role: null, name: null }, sync: { online: false, waiting: 0, notTaken: 0, stuck: 0 } })))).toEqual(['no_signal']);
  });

  it('sends a company’s only supervisor to the office dashboard, with or without someone to make supervisor', () => {
    const lone: DeletionCheckCompany = { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], running: 0 };
    const samPhone = (check: DeletionCheckCompany[]) =>
      ownPhone({ me: SAM, account: { email: 'sam@example.com', passwordHash: 'h' }, linked: { ...PIT, role: 'supervisor', userId: 'u-sam', email: 'sam@example.com' }, standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, serverAccount: { id: 'u-sam', email: 'sam@example.com' }, check });
    for (const check of [[lone], [{ ...lone, successors: [{ rosterId: 'r-1', firstName: 'Riley J', lastName: 'Quinn' }] }]]) {
      const plan = deletionPlan(samPhone(check));
      expect(plan.blockers).toEqual([
        {
          kind: 'last_supervisor',
          title: 'You are Test Pit A’s only supervisor',
          body: 'Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make someone else a supervisor, or close the company, on the office dashboard.',
          action: 'dashboard',
        },
      ]);
      expect(plan.finishOnDashboard).toBe(true);
    }
    // Another supervisor: nothing stops it, and a subscription still charged is a warning about the billing email.
    const plan = deletionPlan(samPhone([{ ...lone, lastSupervisor: false, running: 1 }]));
    expect(plan.blockers).toEqual([]);
    expect(plan.finishOnDashboard).toBe(false);
    expect(plan.warnings).toEqual([
      'Test Pit A’s subscription stays with the company. If its invoices come to your email, have another supervisor change the billing email on the office dashboard first.',
    ]);
  });

  it('names every company where they are the only supervisor', () => {
    const check: DeletionCheckCompany[] = [
      { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], running: 0 },
      { id: 'c-b', name: 'Test Pit B', role: 'supervisor', lastSupervisor: true, successors: [], running: 0 },
    ];
    expect(deletionPlan(input({ serverAccount: { id: 'u', email: 'sam@example.com' }, check })).blockers[0].title).toBe('You are Test Pit A’s and Test Pit B’s only supervisor');
  });
});

describe('a phone joined with someone else’s sign-in', () => {
  it('deletes the account on the phone only, and leaves the sign-in as it is', () => {
    const plan = deletionPlan(
      ownPhone({ standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, serverAccount: { id: 'u-sam', email: 'sam@example.com' }, check: 'unknown' }),
    );
    expect(plan.serverToo).toBe(false);
    expect(plan.needsPassword).toBe(false);
    expect(plan.clearsPhone).toBe(false);
    expect(plan.phone).toEqual([
      'Your records stay on this phone, which others sign in to. They keep going to Test Pit A with this phone’s company sign-in.',
      'This phone’s company sign-in is Sam Ortiz’s, and it is not changed.',
      'If you have a company sign-in on another phone, delete it there, or at app.minemuster.com/account.',
    ]);
    // Nothing of the server is in the way: no signal is needed for the phone's own account.
    expect(deletionPlan(ownPhone({ standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, sync: { online: false, waiting: 9, notTaken: 0, stuck: 0 } })).blockers).toEqual([]);
  });

  it('says so when their own sign-in is signed out on this phone, and deletes the rest', () => {
    const plan = deletionPlan(ownPhone({ serverAccount: null }));
    expect(plan.serverToo).toBe(false);
    expect(plan.warnings).toContain(
      'Your company sign-in, riley@example.com, is signed out on this phone, so it is not deleted here. Sign in to it on Company account first to delete it too, or delete it at app.minemuster.com/account.',
    );
  });
});

describe('what stops it, and what to look at first', () => {
  it('waits for a clock-out, and says until when at lunch', () => {
    const clockedIn = shiftAt(NOW - 3 * 3_600_000);
    expect(deletionPlan(input({ openShift: clockedIn })).blockers).toEqual([
      { kind: 'on_clock', title: 'Clock out first', body: 'You are on the clock. Clock out, then delete your account.', action: 'clock' },
    ]);
    const lunch = { start: { at: NOW - 10 * 60_000 }, end: { at: NOW - 10 * 60_000 + LUNCH_MS, auto: true } };
    const atLunch = shiftAt(NOW - 3 * 3_600_000, { lunches: [lunch] });
    expect(deletionPlan(input({ openShift: atLunch })).blockers).toEqual([
      { kind: 'at_lunch', title: 'Clock out first', body: `You are at lunch until ${hhmm(NOW + 20 * 60_000)}. Clock out after that, then delete your account.`, action: 'clock' },
    ]);
    // After lunch, on the clock again.
    const after = shiftAt(NOW - 3 * 3_600_000, { lunches: [{ start: { at: NOW - 40 * 60_000 }, end: { at: NOW - 10 * 60_000, auto: true } }] });
    expect(kinds(deletionPlan(input({ openShift: after })))).toEqual(['on_clock']);
  });

  it('warns of a unit still checked out and of an old shift with no clock-out, and stops for neither', () => {
    const plan = deletionPlan(input({ openUnit: 'L-12', staleShift: shiftAt(Date.UTC(2026, 10, 17, 14)) }));
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([
      'You still have L-12 checked out. Check it in from the Checklists screen so the next operator can take it.',
      'Your shift of 2026-11-17 has no clock-out. It counts no hours until a supervisor sets its end.',
    ]);
  });

  it('deletes no made-up sample account, and says to reset the sample data instead', () => {
    const plan = deletionPlan(input({ sample: true, openShift: shiftAt(NOW - 3_600_000) }));
    expect(plan.blockers).toEqual([
      { kind: 'sample', title: 'This is a made-up sample account', body: 'Sample accounts are not deleted. To start over, reset the sample data on More.', action: 'reset' },
    ]);
    expect(plan.needsPassword).toBe(false);
  });
});

describe('a company sign-in with no account on the phone', () => {
  it('is deleted from the server alone', () => {
    const plan = deletionPlan(input({ me: null, account: null, hasRate: false, serverAccount: { id: 'u-pat', email: 'pat@example.com' }, check: [] }));
    expect(plan.title).toBe('Delete this company sign-in');
    expect(plan.intro).toBe('Deleting your company sign-in takes it off MineMuster’s server and signs this phone out of it. It cannot be undone.');
    expect(plan.deletes).toEqual([
      'Your company sign-in, pat@example.com, on MineMuster’s server. It stops working on every phone and on the office dashboard.',
      'Your requests to join a company.',
    ]);
    expect(plan.keeps).toEqual([]);
    expect(plan.needsPassword).toBe(true);
    expect(plan.clearsPhone).toBe(false);
  });
});

describe('the words around it', () => {
  it('names the row on More by what goes and what stays', () => {
    expect(moreRowWords({ keepsTime: true, sample: false, company: 'Test Pit A' })).toEqual({
      title: 'Delete my account',
      sub: 'Your sign-in, password and hourly rate. Your work records stay with Test Pit A.',
    });
    expect(moreRowWords({ keepsTime: false, sample: false, company: '' }).sub).toBe('Your sign-in and password. Your checklists, exams and requests stay with your company.');
    expect(moreRowWords({ keepsTime: true, sample: true, company: 'Sample Mining Co.' }).sub).toBe('A made-up sample account. Reset the sample data to start over.');
  });

  it('asks a person taken off the roster before taking their account off this phone', () => {
    expect(offRosterWords('riley@example.com', 'Test Pit A')).toEqual({
      button: 'Delete this account from this phone',
      title: 'Delete this account?',
      body: 'riley@example.com and its password are taken off this phone. Your records stay with Test Pit A. If you have a company sign-in, delete it at app.minemuster.com/account.',
      confirm: 'Delete this account',
      keep: 'Keep it',
    });
    expect(DELETED_TOAST).toBe('Your account is deleted.');
  });
});
