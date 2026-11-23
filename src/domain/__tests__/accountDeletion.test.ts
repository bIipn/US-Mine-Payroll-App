import {
  ACCOUNT_PAGE,
  CHECK_FAILED_BLOCKER,
  clockBlocker,
  DELETED_TOAST,
  deletionPlan,
  legalLine,
  moreRowWords,
  offRosterWords,
  sendable,
  signOutBlockers,
  signOutWarnings,
  signOutWords,
  whoseSignIn,
  type DeletionCheckCompany,
  type DeletionInput,
  type SignOutInput,
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
    caughtUp: true,
    sync: { online: true, waiting: 0, notTaken: 0, stuck: 0, trouble: null },
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
    check: [{ id: 'c-a', name: 'Test Pit A', role: 'employee', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: null }],
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
    expect(plan.phone).toEqual([
      'Everything on this phone has reached Test Pit A, so the phone is cleared too and goes back to how the app starts.',
      // An account made in the app elsewhere is that phone's: it is not on the server, so it is not deleted here.
      'An account you made in the app on another phone stays on that phone. Delete it there, under More.',
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('clears no phone that others sign in to, or that holds anything the company does not have', () => {
    for (const over of [{ otherAccounts: 1 }, { sync: { online: true, waiting: 0, notTaken: 2, stuck: 0, trouble: null } }, { sync: { online: true, waiting: 0, notTaken: 0, stuck: 1, trouble: null } }]) {
      expect(deletionPlan(ownPhone(over)).clearsPhone).toBe(false);
    }
    const shared = deletionPlan(ownPhone({ otherAccounts: 2, othersOnClock: 3 }));
    expect(shared.phone).toEqual([
      'This phone sends Test Pit A’s records with your company sign-in, the crew’s included. Once it is deleted, the phone stops sending until it is joined again with another sign-in.',
      '3 people are on the clock on this phone. Their punches wait on the phone until then.',
      'Your records stay on this phone. They are Test Pit A’s; a supervisor clears them from the phone.',
      'An account you made in the app on another phone stays on that phone. Delete it there, under More.',
    ]);
    expect(deletionPlan(ownPhone({ otherAccounts: 1, othersOnClock: 1 })).phone[1]).toBe('1 person is on the clock on this phone. Their punches wait on the phone until then.');
  });

  it('waits for the records to reach the company first, and says it needs signal', () => {
    const waiting = deletionPlan(ownPhone({ sync: { online: true, waiting: 4, notTaken: 0, stuck: 0, trouble: null } }));
    expect(waiting.blockers).toEqual([
      { kind: 'waiting', title: '4 records have not reached Test Pit A yet', body: 'They are sent before your company sign-in is deleted, so the company has them.', action: 'send' },
    ]);
    const one = deletionPlan(ownPhone({ sync: { online: false, waiting: 1, notTaken: 0, stuck: 0, trouble: null } }));
    expect(one.blockers).toEqual([
      { kind: 'waiting', title: '1 record has not reached Test Pit A yet', body: 'They are sent before your company sign-in is deleted, so the company has them. This needs signal.', action: 'send' },
    ]);
  });

  it('needs signal, and says nothing has been deleted', () => {
    const plan = deletionPlan(ownPhone({ sync: { online: false, waiting: 0, notTaken: 0, stuck: 0, trouble: null } }));
    expect(plan.blockers).toEqual([
      { kind: 'no_signal', title: 'This needs signal', body: 'Deleting your company sign-in is done on MineMuster’s server. Try again when you have signal. Nothing has been deleted.' },
    ]);
    // A phone that never joined needs it too, to delete the company sign-in it is signed in with.
    expect(kinds(deletionPlan(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' }, sync: { online: false, waiting: 0, notTaken: 0, stuck: 0, trouble: null } })))).toEqual(['no_signal']);
  });

  it('waits while the server is asked, and while the phone has not heard who its sign-in is', () => {
    expect(deletionPlan(ownPhone({ check: 'checking' })).blockers).toEqual([{ kind: 'checking', title: 'Checking your account with MineMuster’s server…', body: '' }]);
    expect(kinds(deletionPlan(ownPhone({ standing: { role: null, name: null } })))).toEqual(['checking']);
    expect(kinds(deletionPlan(ownPhone({ standing: { role: null, name: null }, sync: { online: false, waiting: 0, notTaken: 0, stuck: 0, trouble: null } })))).toEqual(['no_signal']);
  });

  it('sends a company’s only supervisor to the office dashboard, with or without someone to make supervisor', () => {
    const lone: DeletionCheckCompany = { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], canClose: true, closeFrom: null, running: 0 };
    const samPhone = (check: DeletionCheckCompany[]) =>
      ownPhone({ me: SAM, account: { email: 'sam@example.com', passwordHash: 'h' }, linked: { ...PIT, role: 'supervisor', userId: 'u-sam', email: 'sam@example.com' }, standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, serverAccount: { id: 'u-sam', email: 'sam@example.com' }, check });
    for (const check of [[lone], [{ ...lone, canClose: false, successors: [{ rosterId: 'r-1', firstName: 'Riley J', lastName: 'Quinn' }] }]]) {
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
      { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], canClose: true, closeFrom: null, running: 0 },
      { id: 'c-b', name: 'Test Pit B', role: 'supervisor', lastSupervisor: true, successors: [], canClose: true, closeFrom: null, running: 0 },
    ];
    expect(deletionPlan(input({ serverAccount: { id: 'u', email: 'riley@example.com' }, check })).blockers[0].title).toBe('You are Test Pit A’s and Test Pit B’s only supervisor');
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
    expect(deletionPlan(ownPhone({ standing: { role: 'supervisor', name: { firstName: 'Sam', lastName: 'Ortiz' } }, sync: { online: false, waiting: 9, notTaken: 0, stuck: 0, trouble: null } })).blockers).toEqual([]);
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

  it('is the same clock-out check for signing out of the phone, in its words', () => {
    expect(clockBlocker(shiftAt(NOW - 3 * 3_600_000), NOW, 'sign out', hhmm)).toEqual({
      kind: 'on_clock',
      title: 'Clock out first',
      body: 'You are on the clock. Clock out, then sign out.',
      action: 'clock',
    });
    // A lunch runs its full 30 minutes and cannot be clocked out of: clock out after it, then sign out.
    const lunch = { start: { at: NOW - 10 * 60_000 }, end: { at: NOW - 10 * 60_000 + LUNCH_MS, auto: true } };
    expect(clockBlocker(shiftAt(NOW - 3 * 3_600_000, { lunches: [lunch] }), NOW, 'sign out', hhmm)).toEqual({
      kind: 'at_lunch',
      title: 'Clock out first',
      body: `You are at lunch until ${hhmm(NOW + 20 * 60_000)}. Clock out after that, then sign out.`,
      action: 'clock',
    });
    expect(clockBlocker(undefined, NOW, 'sign out', hhmm)).toBeNull();
  });

  it('warns of a unit still checked out and of an old shift with no clock-out, and stops for neither', () => {
    const plan = deletionPlan(input({ openUnit: 'L-12', staleShift: shiftAt(Date.UTC(2026, 10, 17, 14)) }));
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([
      'You still have L-12 checked out. End use on the Checklists screen so the next operator can take it.',
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

  it('asks a person taken off the roster before taking their account off this phone, saying the rate goes and why the records stay', () => {
    expect(offRosterWords({ email: 'riley@example.com', company: 'Test Pit A', keepsTime: true, hasRate: true })).toEqual({
      button: 'Delete this account from this phone',
      title: 'Delete this account?',
      body: 'riley@example.com and its password, and the hourly rate you entered, are taken off this phone. Your records stay with Test Pit A. If you have a company sign-in, delete it at app.minemuster.com/account.',
      legal: legalLine('Test Pit A', true),
      confirm: 'Delete this account',
      keep: 'Keep it',
    });
    // No rate on the phone, or a company that keeps no time: no rate named, and the reason follows keepsTime.
    expect(offRosterWords({ email: 'riley@example.com', company: 'Test Pit A', keepsTime: true, hasRate: false }).body).toBe(
      'riley@example.com and its password are taken off this phone. Your records stay with Test Pit A. If you have a company sign-in, delete it at app.minemuster.com/account.',
    );
    const safety = offRosterWords({ email: 'riley@example.com', company: '', keepsTime: false, hasRate: true });
    expect(safety.body).not.toMatch(/hourly rate/);
    expect(safety.legal).toBe('They are your company’s records. The company keeps pre shift exam records for at least a year, as 30 CFR 56.18002 has it. A plain-language summary, not legal advice.');
    expect(DELETED_TOAST).toBe('Your account is deleted.');
  });
});

describe('a phone that never joined, signed in to the server under another email', () => {
  // A supervisor signed in on Company account, waiting to join the phone, while Riley is signed in to the app.
  const waitingToJoin = (over: Partial<DeletionInput> = {}) => input({ serverAccount: { id: 'u-sam', email: 'sam@example.com' }, ...over });

  it('counts the sign-in as the app account’s only when it is under the same email', () => {
    expect(whoseSignIn(waitingToJoin())).toEqual({ kind: 'other_email', email: 'sam@example.com' });
    expect(whoseSignIn(input({ serverAccount: { id: 'u-riley', email: ' Riley@Example.com ' } }))).toEqual({ kind: 'theirs', email: ' Riley@Example.com ', connected: false });
    // The company sign-in alone, from Company account: its password shows whose it is.
    expect(whoseSignIn(waitingToJoin({ me: null, account: null }))).toEqual({ kind: 'theirs', email: 'sam@example.com', connected: false });
  });

  it('deletes Riley’s account on the phone without Sam’s password, and says Sam’s sign-in is left as it is', () => {
    const plan = deletionPlan(waitingToJoin());
    expect([plan.serverToo, plan.needsPassword, plan.passwordLabel]).toEqual([false, false, undefined]);
    expect(plan.deletes.join(' ')).not.toMatch(/sam@example\.com/);
    expect(plan.warnings).toContain(
      'This phone is signed in to MineMuster’s server as sam@example.com, not as riley@example.com, so that sign-in is not deleted with your account. If it is yours, delete it at app.minemuster.com/account.',
    );
    // Nothing of the server is in the way, so no signal is needed.
    expect(deletionPlan(waitingToJoin({ sync: { online: false, waiting: 0, notTaken: 0, stuck: 0, trouble: null } })).blockers).toEqual([]);
  });
});

describe('time and pay lines, with time tracking off', () => {
  it('names no hourly rate, no old shift and no clock-out for a company that keeps no time', () => {
    const plan = deletionPlan(
      input({ keepsTime: false, hasRate: true, openShift: shiftAt(NOW - 3_600_000), staleShift: shiftAt(Date.UTC(2026, 10, 17, 14)) }),
    );
    expect(plan.deletes).toEqual(['Your sign-in on this phone, riley@example.com, and its password.']);
    expect(plan.blockers).toEqual([]);
    expect([...plan.deletes, ...plan.keeps, ...plan.warnings, plan.legal].join(' ')).not.toMatch(/hourly rate|clock-out|clock out|punch/i);
    // With time kept, both are said.
    const time = deletionPlan(input({ hasRate: true, staleShift: shiftAt(Date.UTC(2026, 10, 17, 14)) }));
    expect(time.deletes).toContain('Your hourly rate, kept only on this phone.');
    expect(time.warnings).toContain('Your shift of 2026-11-17 has no clock-out. It counts no hours until a supervisor sets its end.');
  });
});

describe('which company the lines name', () => {
  const company = (name: string, id: string): DeletionCheckCompany => ({ id, name, role: 'employee', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: null });

  it('titles what stays with the company the lines name, the server’s when the phone has none', () => {
    const fresh = deletionPlan(input({ company: '', serverAccount: { id: 'u-riley', email: 'riley@example.com' }, check: [company('Test Pit Q', 'c-q')] }));
    expect(fresh.keepsTitle).toBe('What stays with Test Pit Q');
    expect(fresh.keeps[0]).toBe('Your name on Test Pit Q’s roster. A supervisor takes it off when you leave.');
    expect(deletionPlan(input()).keepsTitle).toBe('What stays with Test Pit A');
  });

  it('names each company for an account in more than one', () => {
    const plan = deletionPlan(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' }, check: [company('Test Pit A', 'c-a'), company('Test Pit B', 'c-b')] }));
    expect(plan.keepsTitle).toBe('What stays with each company');
    expect(plan.keeps).toEqual([
      'Your name on Test Pit A’s and Test Pit B’s rosters. A supervisor takes it off when you leave.',
      'Your punches, paid leave, equipment checklists, pre shift exams and maintenance requests, with your name on them.',
      'MineMuster keeps them for each company while it uses MineMuster, and deletes them when the company asks.',
    ]);
    expect(plan.legal).toBe(legalLine('', true, true));
    expect(plan.legal.startsWith('They are each company’s records.')).toBe(true);
  });
});

describe('asking the server first', () => {
  it('waits on the first look, and offers Try again when the server did not answer, deleting nothing', () => {
    // Not asked yet: the screen asks as soon as it opens, so it waits rather than going ahead.
    expect(kinds(deletionPlan(ownPhone({ check: 'unknown' })))).toEqual(['checking']);
    const failed = deletionPlan(ownPhone({ check: 'failed' }));
    expect(failed.blockers).toEqual([CHECK_FAILED_BLOCKER]);
    expect(CHECK_FAILED_BLOCKER).toEqual({
      kind: 'check_failed',
      title: 'Could not check your account with MineMuster’s server',
      body: 'Before your company sign-in is deleted, the server says what stays with each company. Nothing has been deleted.',
      action: 'retry',
    });
    // A dashboard-only supervisor's sign-in on a fresh phone: the check must answer before it goes.
    expect(kinds(deletionPlan(input({ me: null, account: null, hasRate: false, serverAccount: { id: 'u-pat', email: 'pat@example.com' }, check: 'failed' })))).toEqual([
      'check_failed',
    ]);
    // No signal comes first: that is what to fix.
    expect(kinds(deletionPlan(ownPhone({ check: 'failed', sync: { online: false, waiting: 0, notTaken: 0, stuck: 0, trouble: null } })))).toEqual(['no_signal']);
  });

  it('says from when a company can be closed when only people taken off lately stand in the way', () => {
    const later: DeletionCheckCompany = { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], canClose: false, closeFrom: '2026-12-20T18:00:00+00:00', running: 0 };
    const plan = deletionPlan(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' }, check: [later] }));
    expect(plan.blockers[0]).toEqual({
      kind: 'last_supervisor',
      title: 'You are Test Pit A’s only supervisor',
      body: 'Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make someone else a supervisor, or close the company, on the office dashboard. Test Pit A can be closed from 2026-12-20: someone taken off its roster in the last 30 days could still be put back.',
      action: 'dashboard',
    });
    // Someone who can take over now: no date, since handing over is the way.
    const handover = deletionPlan(input({ serverAccount: { id: 'u-riley', email: 'riley@example.com' }, check: [{ ...later, closeFrom: null, successors: [{ rosterId: 'r-2', firstName: 'Lee', lastName: 'Park' }] }] }));
    expect(handover.blockers[0].body).not.toMatch(/can be closed from/);
  });
});

describe('records that cannot be sent', () => {
  it('counts only what a round could still send', () => {
    expect(sendable({ waiting: 5, stuck: 2, trouble: null })).toBe(3);
    expect(sendable({ waiting: 2, stuck: 2, trouble: 'refused' })).toBe(0);
    expect(sendable({ waiting: 4, stuck: 0, trouble: 'not_member' })).toBe(0);
    expect(sendable({ waiting: 4, stuck: 0, trouble: 'closed' })).toBe(0);
    expect(sendable({ waiting: 4, stuck: 0, trouble: 'unreachable' })).toBe(4);
    expect(sendable({ waiting: 1, stuck: 3, trouble: null })).toBe(0);
  });

  it('does not hold the deletion up for records the server will not take, and says they stay on the phone', () => {
    const refused = deletionPlan(ownPhone({ sync: { online: true, waiting: 3, notTaken: 0, stuck: 3, trouble: 'refused' } }));
    expect(refused.blockers).toEqual([]);
    expect(refused.warnings).toContain('3 records cannot be sent to Test Pit A, so they stay on this phone.');
    expect(refused.clearsPhone).toBe(false);
    // A sign-in off the company's roster sends nothing more: what waits stays, and the deletion goes ahead.
    const off = deletionPlan(ownPhone({ sync: { online: true, waiting: 2, notTaken: 0, stuck: 0, trouble: 'not_member' } }));
    expect(off.blockers).toEqual([]);
    expect(off.warnings).toContain('2 records cannot be sent to Test Pit A, so they stay on this phone.');
    // What can still go is sent first, and only that is counted.
    const some = deletionPlan(ownPhone({ sync: { online: true, waiting: 5, notTaken: 0, stuck: 1, trouble: null } }));
    expect(some.blockers.map((b) => [b.kind, b.title])).toEqual([['waiting', '4 records have not reached Test Pit A yet']]);
    expect(some.warnings).toContain('1 record cannot be sent to Test Pit A, so it stays on this phone.');
  });

  it('clears no phone that has not read its company’s records to the end', () => {
    expect(deletionPlan(ownPhone()).clearsPhone).toBe(true);
    expect(deletionPlan(ownPhone({ caughtUp: false })).clearsPhone).toBe(false);
  });
});

describe('signing out of a phone', () => {
  // Signing out empties the phone, so it waits as the deletion plan's clearing of a phone does, until nothing
  // on it would be lost, and says what holds it up and what to do.
  const quiet = { online: true, waiting: 0, notTaken: 0, stuck: 0, trouble: null };
  /** Riley's own phone: nothing open, nothing waiting, no one else's account, the company's records read to the end. */
  const out = (over: Partial<SignOutInput> = {}): SignOutInput => ({
    now: NOW,
    company: 'Test Pit A',
    otherAccounts: 0,
    caughtUp: true,
    sync: quiet,
    fmtTime: hhmm,
    fmtDay: day,
    ...over,
  });

  it('is allowed once nothing on the phone would be lost', () => {
    expect(signOutBlockers(out())).toEqual({ blockers: [], warnings: [] });
  });

  it('waits for the shift and any unit, which only this phone can close', () => {
    expect(signOutBlockers(out({ openShift: shiftAt(NOW - 3 * 3_600_000), openUnit: 'L-12' })).blockers).toEqual([
      { kind: 'on_clock', title: 'Clock out first', body: 'You are on the clock. Clock out, then sign out.', action: 'clock' },
      { kind: 'unit_out', title: 'End use first', body: 'You still have L-12 checked out. End use on the Checklists screen, then sign out.', action: 'checklists' },
    ]);
  });

  it('waits for anyone else’s account on the phone, and for the company’s records read to the end', () => {
    expect(signOutBlockers(out({ otherAccounts: 1, caughtUp: false })).blockers).toEqual([
      {
        kind: 'other_accounts',
        title: 'Someone else has an account on this phone',
        body: 'Signing out empties the phone, and their account would go with it. A supervisor clears the phone once they are done with it.',
      },
      {
        kind: 'not_read',
        title: 'This phone has not read Test Pit A’s records yet',
        body: 'Until it has, it cannot tell that everything on it has reached the company. Try again once it has had signal.',
        action: 'send',
      },
    ]);
    expect(signOutBlockers(out({ otherAccounts: 2 })).blockers).toEqual([
      {
        kind: 'other_accounts',
        title: '2 other people have accounts on this phone',
        body: 'Signing out empties the phone, and their accounts would go with it. A supervisor clears the phone once they are done with it.',
      },
    ]);
  });

  it('waits for what has not reached the company, and for what the company turned down', () => {
    // Two waiting, one of them a record the server will not take as it is, and one held.
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 2, stuck: 1, notTaken: 1 } })).blockers).toEqual([
      { kind: 'waiting', title: '1 record has not reached Test Pit A yet', body: 'They are sent before this phone is signed out, so the company has them.', action: 'send' },
      { kind: 'not_taken', title: 'Test Pit A turned down 2 records', body: 'Signing out would take them off this phone. A supervisor can look at them with you.' },
    ]);
    expect(signOutBlockers(out({ sync: { ...quiet, notTaken: 1 } })).blockers).toEqual([
      { kind: 'not_taken', title: 'Test Pit A turned down 1 record', body: 'Signing out would take it off this phone. A supervisor can look at it with you.' },
    ]);
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 3, online: false } })).blockers).toEqual([
      { kind: 'waiting', title: '3 records have not reached Test Pit A yet', body: 'They are sent before this phone is signed out, so the company has them. This needs signal.', action: 'send' },
    ]);
    // MineMuster has stopped for the company: they wait until a supervisor starts it again.
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 1, trouble: 'closed' } })).blockers).toEqual([
      {
        kind: 'waiting',
        title: '1 record has not reached Test Pit A yet',
        body: 'MineMuster has stopped for this company, so they wait on this phone. A supervisor can start it again on the dashboard’s Billing page.',
      },
    ]);
  });

  it('says what waits can never reach the company from a sign-in off its roster, and to delete the account instead', () => {
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 2, notTaken: 1, trouble: 'not_member' } })).blockers).toEqual([
      {
        kind: 'not_member',
        title: 'This phone’s company sign-in is off Test Pit A’s roster',
        body: '3 records on this phone cannot reach the company now, and signing out would lose them. Delete your account instead: they stay on this phone.',
        action: 'delete',
      },
    ]);
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 1, trouble: 'not_member' } })).blockers[0].body).toBe(
      '1 record on this phone cannot reach the company now, and signing out would lose it. Delete your account instead: it stays on this phone.',
    );
    // With nothing on the phone to lose, nothing holds it up.
    expect(signOutBlockers(out({ sync: { ...quiet, trouble: 'not_member' } })).blockers).toEqual([]);
  });

  it('asks for the company sign-in again first when it is signed out on the phone, so what waits can go', () => {
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 2, trouble: 'signed_out' } })).blockers).toEqual([
      {
        kind: 'signed_out',
        title: 'Your company sign-in is signed out on this phone',
        body: 'Sign in to it on Company account first to send the 2 records waiting here, then sign out.',
        action: 'sign_in',
      },
    ]);
    expect(signOutBlockers(out({ sync: { ...quiet, waiting: 1, trouble: 'signed_out' } })).blockers[0].body).toBe(
      'Sign in to it on Company account first to send the record waiting here, then sign out.',
    );
    // With nothing waiting, being signed out holds nothing up.
    expect(signOutBlockers(out({ sync: { ...quiet, trouble: 'signed_out' } })).blockers).toEqual([]);
  });

  it('warns of an old shift with no clock-out, which only a supervisor can end now, as the deletion plan does', () => {
    const stale = shiftAt(Date.UTC(2026, 10, 17, 14));
    const words = 'Your shift of 2026-11-17 has no clock-out. It counts no hours until a supervisor sets its end.';
    expect(signOutBlockers(out({ staleShift: stale }))).toEqual({ blockers: [], warnings: [words] });
    expect(deletionPlan(input({ staleShift: stale })).warnings).toContain(words);
    // The same warning, for the question asked before signing out, when nothing holds it up and the phone is emptied.
    expect(signOutWarnings({ staleShift: stale, fmtDay: day })).toEqual([words]);
    expect(signOutWarnings({ fmtDay: day })).toEqual([]);
  });
});

describe('a crew member’s passcode sign-in', () => {
  // A crew member signs in with the company code, a name and a passcode, and has no email: the phone holds
  // no address for the sign-in (the server's hidden one never reaches it), and the app account the sign-in
  // opened has none either. Lee Park is made up.
  const LEE: Employee = { id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true };
  const LEES_SIGN_IN = { id: 'u-lee', email: '', kind: 'passcode' as const };
  const leesPit = { id: 'c-a', name: 'Test Pit A', role: 'employee' as const, userId: 'u-lee', email: '' };
  /** Lee's own phone: joined with Lee's passcode sign-in, which opened Lee's account here. */
  const leesPhone = (over: Partial<DeletionInput> = {}) =>
    input({
      me: LEE,
      account: { email: '' },
      linked: leesPit,
      standing: { role: 'employee', name: { firstName: 'Lee', lastName: 'Park' } },
      serverAccount: LEES_SIGN_IN,
      check: [{ id: 'c-a', name: 'Test Pit A', role: 'employee', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: null }],
      ...over,
    });
  /** Every line the plan shows. */
  const said = (plan: ReturnType<typeof deletionPlan>) =>
    [plan.title, plan.intro, plan.keepsTitle, plan.keep, ...plan.deletes, ...plan.keeps, plan.legal, ...plan.phone, ...plan.warnings, ...plan.blockers.flatMap((b) => [b.title, b.body]), plan.passwordLabel ?? ''].join(' ');

  it('is theirs, with no address, wherever the phone has it', () => {
    expect(whoseSignIn(leesPhone())).toEqual({ kind: 'theirs', email: '', passcode: true, connected: true });
    // A phone that never joined: a passcode has no email to match, and the passcode shows whose it is.
    expect(whoseSignIn(input({ serverAccount: LEES_SIGN_IN }))).toEqual({ kind: 'theirs', email: '', passcode: true, connected: false });
    // Signed out on the phone: no address to name.
    expect(whoseSignIn(leesPhone({ serverAccount: null }))).toEqual({ kind: 'theirs_signed_out', email: null });
  });

  it('deletes with the passcode, and says what goes and what stays with no email or password in it', () => {
    const plan = deletionPlan(leesPhone());
    expect(plan.title).toBe('Delete my account');
    expect([plan.serverToo, plan.needsPasscode, plan.needsPassword, plan.passwordLabel]).toEqual([true, true, false, undefined]);
    expect(plan.deletes).toEqual([
      'Your sign-in on this phone.',
      'Your hourly rate, kept only on this phone.',
      'Your company sign-in and its passcode, on MineMuster’s server. It stops working on every phone.',
      'Your requests to join a company.',
    ]);
    expect(plan.keeps).toEqual([
      'Your name on Test Pit A’s roster. A supervisor takes it off when you leave.',
      'Your punches, paid leave, equipment checklists, pre shift exams and maintenance requests, with your name on them.',
      'MineMuster keeps them for Test Pit A while it uses MineMuster, and deletes them when the company asks.',
    ]);
    expect(plan.keep).toBe('Keep my account');
    expect(said(plan)).not.toMatch(/@|e-?mail|password/i);
  });

  it('is deleted by someone taken off the roster who has no account open on the phone, and says what stays', () => {
    // Off the company's roster: nothing more can be sent with the sign-in, so the record waiting stays on the phone.
    const plan = deletionPlan(
      leesPhone({ me: null, account: null, hasRate: false, standing: { role: 'none', name: { firstName: 'Lee', lastName: 'Park' } }, check: [], sync: { online: true, waiting: 1, notTaken: 0, stuck: 0, trouble: 'not_member' } }),
    );
    expect(plan.signIn).toEqual({ kind: 'theirs', email: '', passcode: true, connected: true });
    expect(plan.title).toBe('Delete my account');
    expect(plan.intro).toBe('Deleting your account takes your sign-in off MineMuster’s server and signs this phone out of it. It cannot be undone.');
    expect(plan.blockers).toEqual([]);
    expect(plan.needsPasscode).toBe(true);
    expect(plan.keepsTitle).toBe('What stays with Test Pit A');
    expect(plan.keeps[0]).toBe('Your name on Test Pit A’s roster. A supervisor takes it off when you leave.');
    expect(plan.warnings).toContain('1 record cannot be sent to Test Pit A, so it stays on this phone.');
    expect(said(plan)).not.toMatch(/@|e-?mail|password/i);
    // Before the phone knows who is signed in to it, it waits.
    expect(kinds(deletionPlan(leesPhone({ me: null, account: null, serverAccount: undefined })))).toEqual(['checking']);
  });

  it('says how to delete a signed-out passcode sign-in without naming an address', () => {
    const plan = deletionPlan(leesPhone({ serverAccount: null }));
    expect(plan.serverToo).toBe(false);
    expect(plan.warnings).toContain(
      'Your company sign-in is signed out on this phone, so it is not deleted here. Sign in to it on Company account first to delete it too, or ask a supervisor to delete it on the office dashboard.',
    );
    expect(said(plan)).not.toMatch(/@|password/i);
  });

  it('names on More what goes with the account, by what it signs in with', () => {
    expect(moreRowWords({ keepsTime: true, sample: false, company: 'Test Pit A', secret: 'passcode' }).sub).toBe('Your sign-in, passcode and hourly rate. Your work records stay with Test Pit A.');
    expect(moreRowWords({ keepsTime: false, sample: false, company: 'Test Pit A', secret: 'passcode' }).sub).toBe('Your sign-in and passcode. Your checklists, exams and requests stay with Test Pit A.');
    // Signed out of the company server, nothing is said of a secret the phone cannot delete now.
    expect(moreRowWords({ keepsTime: true, sample: false, company: 'Test Pit A', secret: null }).sub).toBe('Your sign-in and hourly rate. Your work records stay with Test Pit A.');
    expect(moreRowWords({ keepsTime: false, sample: false, company: 'Test Pit A', secret: null }).sub).toBe('Your sign-in. Your checklists, exams and requests stay with Test Pit A.');
  });
});

describe('the question before signing out of a phone', () => {
  it('says the phone is emptied once everything has reached the company, and that signing back in needs signal', () => {
    expect(signOutWords({ company: 'Test Pit A', connected: true, keepsTime: true, hasRate: true })).toEqual({
      title: 'Sign out of this phone?',
      body: 'Once everything on this phone has reached Test Pit A, the phone is emptied and goes back to how the app starts. Your hourly rate, kept only on this phone, goes with it. Your records stay with Test Pit A.',
      signal: 'Signing back in needs signal.',
      confirm: 'Sign out of this phone',
      keep: 'Stay signed in',
      held: 'Not signed out yet',
      heldBody: 'Nothing has been taken off this phone.',
    });
    // No rate, or a company that keeps no time: no rate named.
    expect(signOutWords({ company: 'Test Pit A', connected: true, keepsTime: false, hasRate: true }).body).toBe(
      'Once everything on this phone has reached Test Pit A, the phone is emptied and goes back to how the app starts. Your records stay with Test Pit A.',
    );
    // A phone not joined to a company keeps everything it holds.
    const apart = signOutWords({ company: '', connected: false, keepsTime: true, hasRate: true });
    expect(apart.body).toBe('This phone is not connected to a company, so everything on it stays here for when you sign in again.');
    expect(apart.signal).toBe('Signing back in needs signal.');
  });
});
