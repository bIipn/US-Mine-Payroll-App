import { connectProblem, otherCompany, parseServer } from '../server';
import {
  authWords,
  checkEmail,
  deletionAnswerWords,
  readDeletionAnswer,
  readDeletionCheck,
  settleDeletion,
  type DeletionAnswer,
  checkJoinCode,
  checkJoinName,
  checkPassword,
  JOIN_STATUSES,
  joinedAnswer,
  joinWords,
  normalJoinCode,
  pickCompany,
  pushTrouble,
  readCompanies,
  readCompanyRow,
  readJoinAnswer,
  readPushAnswer,
  readRows,
  readStanding,
  readWaitingRequests,
  roleWords,
  serverWords,
  spacedJoinCode,
  type JoinAnswer,
  type ServerCompany,
} from '../serverAnswers';
import type { Change } from '../sync';

// Made-up companies and people only: this repository is public.
const PIT_A: ServerCompany = { id: 'c-a', name: 'Test Pit A', role: 'employee', state: 'NV' };
const PIT_B: ServerCompany = { id: 'c-b', name: 'Test Pit B', role: 'supervisor' };

describe('the server a build names', () => {
  it('needs both the address and the key', () => {
    expect(parseServer(undefined, undefined)).toEqual({ server: null });
    expect(parseServer('', 'sb_publishable_x')).toEqual({ server: null });
    expect(parseServer('https://example.supabase.co', '  ')).toEqual({ server: null });
    expect(parseServer(' https://example.supabase.co/ ', ' sb_publishable_x ')).toEqual({
      server: { url: 'https://example.supabase.co', key: 'sb_publishable_x' },
    });
  });

  it('turns back an address that is not a project’s, and says so', () => {
    for (const url of ['http://example.supabase.co', 'example.supabase.co', 'https://example.supabase.co/rest/v1', 'https://exa mple.co']) {
      const read = parseServer(url, 'sb_publishable_x');
      expect(read.server).toBeNull();
      expect(read.error).toMatch(/EXPO_PUBLIC_SUPABASE_URL/);
    }
  });

  it('never builds a secret key into the app, new style or old', () => {
    // base64url by hand, as the app reads it: a test needs no Node types for this.
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = (role: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase', ref: 'example' })}.c2ln`;
    for (const key of ['sb_secret_abcdefghijklmnop', jwt('service_role')]) {
      const read = parseServer('https://example.supabase.co', key);
      expect(read.server).toBeNull();
      expect(read.error).toMatch(/secret key/);
    }
    // The older publishable kind, a JWT for the anon role, is fine.
    expect(parseServer('https://example.supabase.co', jwt('anon')).server).toEqual({ url: 'https://example.supabase.co', key: jwt('anon') });
  });
});

describe('what was typed', () => {
  it('checks the email and the password, with a longer password for a new account', () => {
    expect(checkEmail('pat@example.com')).toBeNull();
    expect(checkEmail(' pat@example.com ')).toBeNull();
    expect(checkEmail('pat@example')).toMatch(/valid email/);
    expect(checkPassword('', false)).toMatch(/Enter your password/);
    expect(checkPassword('short', false)).toBeNull();
    expect(checkPassword('short', true)).toMatch(/at least 8/);
    expect(checkPassword('haulroad88', true)).toBeNull();
  });

  it('reads a join code the forgiving way the server does', () => {
    expect(normalJoinCode('abcd-2345')).toBe('ABCD2345');
    expect(normalJoinCode(' ABCD 2345 ')).toBe('ABCD2345');
    // Phones turn a typed hyphen into a dash.
    expect(normalJoinCode('abcd–2345')).toBe('ABCD2345');
    expect(normalJoinCode('abcd—2345')).toBe('ABCD2345');
    expect(checkJoinCode('abcd-2345')).toBeNull();
  });

  it('says what is wrong with a code before it is sent', () => {
    expect(checkJoinCode('')).toMatch(/Enter the company code/);
    // It is the company code wherever a person reads it: never a "join code".
    for (const typed of ['', 'ABC2345', 'ABCD2O45']) expect(checkJoinCode(typed)).toMatch(/company code/);
    expect(checkJoinCode('ABC2345')).toMatch(/8 letters and numbers/);
    expect(checkJoinCode('ABCD23456')).toMatch(/8 letters and numbers/);
    expect(checkJoinCode('ABCD#345')).toMatch(/8 letters and numbers/);
    // The codes leave out the look-alikes.
    expect(checkJoinCode('ABCD2O45')).toMatch(/no O, 0, I or 1/);
    expect(checkJoinCode('ABCD2045')).toMatch(/no O, 0, I or 1/);
    expect(checkJoinCode('ABIC2345')).toMatch(/no O, 0, I or 1/);
  });

  it('needs a first and a last name', () => {
    expect(checkJoinName('Avery', 'Quill')).toBeNull();
    expect(checkJoinName('  ', 'Quill')).toMatch(/first and last name/);
    expect(checkJoinName('Avery', '')).toMatch(/first and last name/);
  });
});

describe('what join_company answered', () => {
  it('reads every status, with the company and the role', () => {
    expect(readJoinAnswer({ status: 'joined', company_name: 'Test Pit A', role: 'employee' })).toEqual({ status: 'joined', companyName: 'Test Pit A', role: 'employee' });
    expect(readJoinAnswer({ status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' })).toEqual({
      status: 'pending',
      companyName: 'Test Pit A',
      reason: 'not_on_roster',
    });
    expect(readJoinAnswer({ status: 'no_company' })).toEqual({ status: 'no_company' });
    expect(readJoinAnswer({ status: 'joined', company_id: 'c-a', company_name: 'Test Pit A', role: 'boss' })).toEqual({
      status: 'joined',
      companyId: 'c-a',
      companyName: 'Test Pit A',
    });
    expect(readJoinAnswer([{ status: 'already_member', company_name: 'Test Pit A', role: 'supervisor' }])?.role).toBe('supervisor');
  });

  it('turns back an answer it does not know', () => {
    expect(readJoinAnswer(null)).toBeNull();
    expect(readJoinAnswer({ status: 'welcome' })).toBeNull();
    expect(readJoinAnswer('joined')).toBeNull();
  });

  it('connects on joined and already_member only', () => {
    const connects = JOIN_STATUSES.filter((status) => joinedAnswer({ status }));
    expect(connects).toEqual(['already_member', 'joined']);
  });

  it('says in plain words what each status means and what to do', () => {
    const say = (answer: JoinAnswer) => joinWords({ companyName: 'Test Pit A', ...answer });
    expect(say({ status: 'no_company' })).toMatchObject({ title: 'No company has that code', tone: 'warn' });
    expect(say({ status: 'no_company' }).body).toMatch(/Check the code with your supervisor/);
    expect(say({ status: 'already_member' })).toMatchObject({ title: 'You are on Test Pit A’s roster', tone: 'ok' });
    expect(say({ status: 'joined' })).toMatchObject({ title: 'You have joined Test Pit A', tone: 'ok' });
    expect(say({ status: 'denied' })).toMatchObject({ title: 'A supervisor has turned down your request', body: 'Speak to a supervisor at Test Pit A.', tone: 'bo' });
    expect(say({ status: 'ambiguous' })).toMatchObject({ title: 'More than one person fits that name', tone: 'warn' });
    expect(say({ status: 'ambiguous' }).body).toMatch(/the way it is on Test Pit A’s roster/);
    const pending = say({ status: 'pending', reason: 'not_on_roster' });
    expect(pending).toMatchObject({ title: 'Waiting for a supervisor', tone: 'info' });
    expect(pending.body).toBe('Your name is not on Test Pit A’s roster yet. Once a supervisor lets you in, tap Check again.');
  });

  it('gives every reason a request waits its own words', () => {
    const reasons = ['not_on_roster', 'already_claimed', 'supervisor_row', 'removed', 'released', 'ambiguous'];
    const bodies = reasons.map((reason) => joinWords({ status: 'pending', companyName: 'Test Pit A', reason }).body);
    expect(new Set(bodies).size).toBe(reasons.length);
    expect(joinWords({ status: 'pending', reason: 'something_new' }).body).toMatch(/needs a supervisor/);
    // With no company name, the words still read.
    expect(joinWords({ status: 'denied' }).body).toBe('Speak to a supervisor at the company.');
  });
});

describe('the companies the account is on', () => {
  it('reads my_companies, leaving out rows the phone cannot use', () => {
    const rows = [
      { id: 'c-a', name: 'Test Pit A', state: 'NV', role: 'employee', join_code: null },
      { id: 'c-b', name: 'Test Pit B', role: 'supervisor', join_code: 'ABCD2345' },
      { id: 'c-a', name: 'Test Pit A again', role: 'employee' },
      { id: '', name: 'No id', role: 'employee' },
      { id: 'c-c', name: 'Odd role', role: 'owner' },
      null,
    ];
    expect(readCompanies(rows)).toEqual([PIT_A, { ...PIT_B, joinCode: 'ABCD2345' }]);
    expect(readCompanies(null)).toEqual([]);
    // A join code is read for a supervisor's row only, to show them.
    expect(readCompanies([{ id: 'c-a', name: 'Test Pit A', role: 'employee', join_code: 'ABCD2345' }])).toEqual([{ id: 'c-a', name: 'Test Pit A', role: 'employee' }]);
    expect(spacedJoinCode('abcd2345')).toBe('ABCD 2345');
  });

  it('picks the company an answer is about', () => {
    expect(pickCompany([PIT_A, PIT_B], { status: 'joined', companyId: 'c-b' })).toBe(PIT_B);
    expect(pickCompany([PIT_A], { status: 'joined', companyId: 'c-z' })).toBeNull();
    // The only company the account is on is not taken for an answer that names another.
    expect(pickCompany([PIT_A], { status: 'joined', companyName: 'Somewhere else' })).toBeNull();
    expect(pickCompany([PIT_A], { status: 'joined', companyName: 'test pit a' })).toBe(PIT_A);
    expect(pickCompany([PIT_A], { status: 'joined' })).toBe(PIT_A);
    expect(pickCompany([PIT_A, PIT_B], { status: 'already_member', companyName: ' test pit b ' })).toBe(PIT_B);
    expect(pickCompany([PIT_A, { ...PIT_B, name: 'Test Pit A' }], { status: 'joined', companyName: 'Test Pit A' })).toBeNull();
    expect(pickCompany([], { status: 'joined', companyName: 'Test Pit A' })).toBeNull();
  });

  it('keeps a phone to the one company its records went to', () => {
    expect(connectProblem(null, {}, 'c-a')).toBeNull();
    expect(connectProblem(null, { 'shift:s1': 'abc' }, 'c-a')).toBeNull();
    expect(connectProblem('c-a', { 'shift:s1': 'abc' }, 'c-a')).toBeNull();
    expect(connectProblem('c-a', {}, 'c-b')).toBeNull();
    expect(connectProblem('c-a', { 'shift:s1': 'abc' }, 'c-b')).toMatch(/one company only. To move it, a supervisor clears this device/);
  });

  it('asks before sending to a company with another name than the one the phone holds', () => {
    expect(otherCompany('Test Quarry North', 'Test Pit B')).toBe(true);
    expect(otherCompany('Test Pit A', ' test pit a ')).toBe(false);
    expect(otherCompany('Test Pit A, Inc.', 'Test Pit A Inc')).toBe(false);
    // A phone that names no company has nothing to compare.
    expect(otherCompany('', 'Test Pit B')).toBe(false);
  });

  it('names the role the way the app does', () => {
    expect(roleWords('supervisor')).toBe('Supervisor');
    expect(roleWords('employee')).toBe('Crew');
  });
});

describe('what push_records answered', () => {
  const change = (key: string, rev: string): Change => {
    const [kind, id] = key.split(':');
    return { key, kind: kind as Change['kind'], id, rev, record: rev === 'deleted' ? null : { id } };
  };
  const batch = [change('shift:s1', 'r1'), change('employee:e1', 'r2'), change('leave:l1', 'deleted')];

  const nothing = { took: [], stale: [], floored: [], held: [] };

  it('holds what the server will not take from this account instead of counting it as sent', () => {
    const answer = {
      accepted: [{ key: 'shift:s1', rev: 'r1', conflict: true }, { key: 'leave:l1', rev: 'deleted' }],
      ignored: [{ key: 'employee:e1', rev: 'r2', reason: 'supervisor_only' }],
    };
    expect(readPushAnswer(answer, batch)).toEqual({
      ...nothing,
      took: [
        { key: 'shift:s1', rev: 'r1' },
        { key: 'leave:l1', rev: 'deleted' },
      ],
      held: [{ key: 'employee:e1', rev: 'r2', reason: 'supervisor_only' }],
    });
  });

  it('reads each reason into its own list: stale for the four kinds, the floor of a unit, and what is held', () => {
    const many = [
      change('areaSheet:a1', 'r1'),
      change('settings:company', 'r2'),
      change('equipment:u1', 'r3'),
      change('equipment:u2', 'r4'),
      change('shift:s2', 'r5'),
      change('shift:s3', 'r6'),
      change('exam:x1', 'r7'),
      change('equipment:u3', 'r8'),
      change('mrf:m1', 'r9'),
      change('inspection:i1', 'r10'),
    ];
    const answer = {
      accepted: [],
      ignored: [
        { key: 'areaSheet:a1', rev: 'r1', reason: 'superseded' },
        { key: 'settings:company', rev: 'r2', reason: 'copy' },
        { key: 'equipment:u1', rev: 'r3', reason: 'deleted' },
        { key: 'equipment:u2', rev: 'r4', reason: 'open_request', floor: 'out_of_service' },
        { key: 'shift:s2', rev: 'r5', reason: 'superseded' },
        { key: 'shift:s3', rev: 'r6', reason: 'signed' },
        { key: 'exam:x1', rev: 'r7', reason: 'not_yours' },
        { key: 'equipment:u3', rev: 'r8', reason: 'malformed', problem: 'Change 8 is a unit with no status the app has.' },
        { key: 'mrf:m1', rev: 'r9', reason: 'malformed' },
        { key: 'inspection:i1', rev: 'r10', reason: 'taken' },
      ],
    };
    expect(readPushAnswer(answer, many)).toEqual({
      // The other seven kinds keep what the server holds, as before: counted as sent.
      took: [
        { key: 'shift:s2', rev: 'r5' },
        { key: 'mrf:m1', rev: 'r9' },
        { key: 'inspection:i1', rev: 'r10' },
      ],
      stale: [
        { key: 'areaSheet:a1', rev: 'r1' },
        { key: 'settings:company', rev: 'r2' },
        { key: 'equipment:u1', rev: 'r3' },
      ],
      floored: [{ key: 'equipment:u2', rev: 'r4', floor: 'out_of_service' }],
      held: [
        { key: 'shift:s3', rev: 'r6', reason: 'signed' },
        { key: 'exam:x1', rev: 'r7', reason: 'not_yours' },
        { key: 'equipment:u3', rev: 'r8', reason: 'malformed' },
      ],
    });
  });

  it('only counts what was in the batch, at the version that was sent', () => {
    const answer = {
      accepted: [{ key: 'shift:s1', rev: 'other' }, { key: 'shift:s9', rev: 'r9' }, { key: 'employee:e1', rev: 'r2' }, { key: 'employee:e1', rev: 'r2' }, 'junk', null],
    };
    expect(readPushAnswer(answer, batch)).toEqual({ ...nothing, took: [{ key: 'employee:e1', rev: 'r2' }] });
    expect(readPushAnswer({ accepted: [] }, batch)).toEqual(nothing);
    // A floor that is not a status is a floor of none: read as a change the server set aside, held.
    const unit = [change('equipment:u1', 'r1')];
    expect(readPushAnswer({ accepted: [], ignored: [{ key: 'equipment:u1', rev: 'r1', reason: 'open_request', floor: 'x' }] }, unit)).toEqual({
      ...nothing,
      held: [{ key: 'equipment:u1', rev: 'r1', reason: 'malformed' }],
    });
  });

  it('treats an answer it cannot read as a round that did not get through', () => {
    expect(() => readPushAnswer(null, batch)).toThrow(/does not understand/);
    expect(() => readPushAnswer({ ignored: [] }, batch)).toThrow(/does not understand/);
    expect(() => readPushAnswer({ accepted: [], ignored: 'none' }, batch)).toThrow(/does not understand/);
  });
});

describe('the requests that wait for a supervisor', () => {
  it('reads the ones still waiting, newest first, and leaves out the decided ones', () => {
    const rows = [
      { id: 'r1', company_id: 'c-a', first_name: 'Avery', last_name: 'Quill', reason: 'not_on_roster', status: 'pending', created_at: '2026-11-10T14:00:00Z' },
      { id: 'r2', company_id: 'c-b', first_name: 'Avery', last_name: 'Quill', reason: null, status: 'pending', created_at: '2026-11-12T14:00:00Z' },
      { id: 'r3', company_id: 'c-a', first_name: 'Avery', last_name: 'Quill', status: 'denied', created_at: '2026-11-13T14:00:00Z' },
      { id: 'r4', status: 'pending' },
      'junk',
    ];
    expect(readWaitingRequests(rows).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(readWaitingRequests(rows)[1]).toEqual({ id: 'r1', companyId: 'c-a', firstName: 'Avery', lastName: 'Quill', reason: 'not_on_roster', at: Date.parse('2026-11-10T14:00:00Z') });
    expect(readWaitingRequests(null)).toEqual([]);
  });
});

describe('why records did not go', () => {
  it('tells signal, a signed-out phone, an account off the roster and a record the server will not take apart', () => {
    expect(pushTrouble({ message: 'TypeError: Failed to fetch' }).trouble).toBe('unreachable');
    expect(pushTrouble({ message: 'AbortError: The operation was aborted.' }).trouble).toBe('unreachable');
    expect(pushTrouble({ code: 'PGRST301' }).trouble).toBe('signed_out');
    expect(pushTrouble({ code: '42501', message: 'not a member' }).trouble).toBe('not_member');
    expect(pushTrouble({ code: 'P0002' })).toMatchObject({ trouble: 'not_member', message: 'This account is not on the company’s roster any more.' });
    expect(pushTrouble({ code: '22023', message: 'malformed change' }).trouble).toBe('refused');
    expect(pushTrouble({ code: '54000', message: 'too big' }).trouble).toBe('refused');
    expect(pushTrouble({ code: 'PGRST202' })).toMatchObject({ trouble: 'server', message: 'The company server is not ready to take records yet.' });
    expect(pushTrouble({ code: 'PGRST000', status: 503 }).trouble).toBe('unreachable');
    expect(pushTrouble({ code: 'PGRST001' }).trouble).toBe('unreachable');
    expect(pushTrouble({ code: 'XX000', status: 400 }).trouble).toBe('server');
  });

  it('reads “no such company” as an account off the roster, as the server answers it now (PT404, HTTP 404) and as it did before (P0002, HTTP 500)', () => {
    const offTheRoster = { trouble: 'not_member', message: 'This account is not on the company’s roster any more.' };
    expect(pushTrouble({ code: 'PT404', message: 'No such company.', status: 404 })).toMatchObject(offTheRoster);
    expect(pushTrouble({ code: 'P0002', message: 'No such company.', status: 500 })).toMatchObject(offTheRoster);
    // A 404 that is PostgREST's own, not the function's refusal, is not read as one.
    expect(pushTrouble({ code: 'PGRST202', status: 404 }).trouble).toBe('server');
  });
});

describe('when something goes wrong', () => {
  it('says the server could not be reached when there is no signal', () => {
    for (const e of [undefined, { status: 0 }, { name: 'AuthRetryableFetchError', message: 'x' }, { message: 'TypeError: Failed to fetch' }, { message: 'Network request failed' }]) {
      expect(serverWords(e)).toMatch(/could not be reached/);
      expect(authWords(e)).toMatch(/could not be reached/);
    }
  });

  it('says what each of the server’s refusals means', () => {
    expect(serverWords({ code: '42501', message: 'not signed in' })).toMatch(/signed out of the company server/);
    expect(serverWords({ code: 'PGRST301' })).toMatch(/Sign in again/);
    expect(serverWords({ code: '22023' })).toMatch(/ordinary letters/);
    expect(serverWords({ code: 'P0002' })).toMatch(/not found/);
    expect(serverWords({ code: 'PT404', status: 404 })).toBe(serverWords({ code: 'P0002', status: 500 }));
    expect(serverWords({ code: 'PGRST202' })).toMatch(/not ready/);
    expect(serverWords({ code: 'XX000', message: 'boom' })).toMatch(/Try again in a minute/);
  });

  it('says what went wrong signing in or making an account', () => {
    expect(authWords({ code: 'invalid_credentials', status: 400 })).toBe('That email and password do not match an account. Check the spelling, or tap Forgot password.');
    expect(authWords({ message: 'Invalid login credentials', status: 400 })).toMatch(/^That email and password do not match an account/);
    expect(authWords({ code: 'email_not_confirmed' })).toMatch(/open the link/);
    expect(authWords({ code: 'user_already_exists' })).toBe('That email already has an account. Sign in, or tap Forgot password.');
    expect(authWords({ code: 'weak_password' })).toMatch(/stronger password/);
    expect(authWords({ status: 429, message: 'slow down' })).toMatch(/Too many tries/);
    expect(authWords({ code: 'signup_disabled' })).toMatch(/turned off/);
    expect(authWords({ code: 'unexpected_failure', status: 500 })).toMatch(/Try again in a minute/);
  });
});

describe('what read_shared_records and the roster answered', () => {
  const row = { kind: 'equipment', id: 'eq_t14', rev: 'r1', seq: 7, deleted: false, data: { id: 'eq_t14' } };

  it('reads a page of rows, a seq sent as text included, and leaves each row’s data for the merge to read', () => {
    expect(readRows([row, { ...row, kind: 'settings', id: 'company', seq: '8', data: { anything: 1 } }])).toEqual([
      row,
      { ...row, kind: 'settings', id: 'company', seq: 8, data: { anything: 1 } },
    ]);
    expect(readRows([])).toEqual([]);
  });

  it('throws on a page it cannot read, so the round treats it as one that did not get through', () => {
    for (const bad of [null, {}, [null], [{ ...row, kind: 'shift' }], [{ ...row, seq: 'x' }], [{ ...row, id: 3 }], [{ ...row, deleted: 'no' }], [{ ...row, rev: undefined }]]) {
      expect(() => readRows(bad)).toThrow(/does not understand/);
    }
  });

  it('reads the phone’s own row of the roster, and none as not on the roster', () => {
    expect(readStanding({ first_name: 'Lee', last_name: 'Park', role: 'supervisor' })).toEqual({ role: 'supervisor', name: { firstName: 'Lee', lastName: 'Park' } });
    expect(readStanding([{ first_name: 'Lee', last_name: 'Park', role: 'employee' }])).toEqual({ role: 'employee', name: { firstName: 'Lee', lastName: 'Park' } });
    expect(readStanding(null)).toBeNull();
    expect(readStanding([])).toBeNull();
    expect(() => readStanding({ first_name: 'Lee', role: 'boss' })).toThrow(/does not understand/);
  });

  it('reads the company’s own row: its name, state and pay schedule', () => {
    expect(readCompanyRow({ name: 'Test Pit A', state: 'NV', pay_period: null })).toEqual({ name: 'Test Pit A', state: 'NV', pay: null });
    const pay = { frequency: 'weekly', firstDay: '2026-01-04', daysAfter: 5 };
    expect(readCompanyRow([{ name: 'Test Pit A', state: 'NV', pay_period: pay }])).toEqual({ name: 'Test Pit A', state: 'NV', pay });
    expect(readCompanyRow(null)).toBeNull();
    expect(() => readCompanyRow({ name: 3 })).toThrow(/does not understand/);
  });

  it('says MineMuster has stopped for the company when the read is turned away for it', () => {
    expect(pushTrouble({ code: 'PT402', message: 'MineMuster is not active for this company.', status: 402 })).toMatchObject({
      trouble: 'closed',
      message: 'MineMuster is not active for this company.',
    });
  });
});

describe('deleting a company sign-in', () => {
  it('reads account_deletion_check, and none from an answer it does not understand', () => {
    const raw = [
      {
        id: 'c-a',
        name: 'Test Pit A',
        role: 'supervisor',
        last_supervisor: true,
        successors: [{ roster_id: 'r-1', first_name: 'Riley J', last_name: 'Quinn' }],
        can_close: false,
        close_from: null,
        running: 1,
      },
      { id: 'c-b', name: 'Test Pit B', role: 'employee', last_supervisor: false, successors: [], can_close: false, close_from: null, running: null },
      { id: 'c-c', name: 'Test Pit C', role: 'supervisor', last_supervisor: true, successors: [], can_close: false, close_from: '2026-12-20T18:00:00+00:00', running: 0 },
    ];
    expect(readDeletionCheck(raw)).toEqual([
      {
        id: 'c-a',
        name: 'Test Pit A',
        role: 'supervisor',
        lastSupervisor: true,
        successors: [{ rosterId: 'r-1', firstName: 'Riley J', lastName: 'Quinn' }],
        canClose: false,
        closeFrom: null,
        running: 1,
      },
      { id: 'c-b', name: 'Test Pit B', role: 'employee', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: null },
      { id: 'c-c', name: 'Test Pit C', role: 'supervisor', lastSupervisor: true, successors: [], canClose: false, closeFrom: '2026-12-20T18:00:00+00:00', running: 0 },
    ]);
    expect(readDeletionCheck([])).toEqual([]);
    for (const bad of [
      null,
      {},
      'x',
      [{ id: 'c-a' }],
      [{ ...raw[0], role: 'owner' }],
      [{ ...raw[0], successors: [{ roster_id: 1 }] }],
      [{ ...raw[0], can_close: undefined }],
      [{ ...raw[0], close_from: 20261220 }],
    ]) {
      expect(readDeletionCheck(bad)).toBeNull();
    }
  });

  it('reads each answer of the delete-account function', () => {
    expect(readDeletionAnswer(200, { deleted: true, closed: [] })).toEqual({ kind: 'deleted', closed: [] });
    expect(readDeletionAnswer(200, { deleted: true, closed: ['c-a'] })).toEqual({ kind: 'deleted', closed: ['c-a'] });
    // Only the function's own 410 says the sign-in is deleted already. A plain 401 says nothing of the kind.
    expect(readDeletionAnswer(410, { error: 'already_deleted' })).toEqual({ kind: 'already_deleted' });
    expect(readDeletionAnswer(401, { error: 'signed_out' })).toEqual({ kind: 'signed_out' });
    expect(readDeletionAnswer(401, { message: 'Invalid JWT' })).toEqual({ kind: 'signed_out' });
    expect(readDeletionAnswer(410, null)).toEqual({ kind: 'try_again', closed: [] });
    // The request went, and the function could not tell whether the sign-in was deleted.
    expect(readDeletionAnswer(504, { error: 'not_known', closed: ['c-a'] })).toEqual({ kind: 'not_known', closed: ['c-a'] });
    expect(readDeletionAnswer(403, { error: 'password_needed' })).toEqual({ kind: 'password_needed' });
    expect(readDeletionAnswer(409, { error: 'last_supervisor', companies: [{ id: 'c-a', name: 'Test Pit A', successors: [] }] })).toEqual({ kind: 'last_supervisor', companies: ['Test Pit A'] });
    expect(readDeletionAnswer(500, { error: 'try_again', closed: ['c-a'] })).toEqual({ kind: 'try_again', closed: ['c-a'] });
    expect(readDeletionAnswer(500, { error: 'not_set_up' })).toEqual({ kind: 'not_ready' });
    // The function not deployed yet: the gateway answers 404.
    expect(readDeletionAnswer(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })).toEqual({ kind: 'not_ready' });
    for (const [status, body] of [[200, { deleted: false }], [200, null], [409, { error: 'close_refused', reason: 'wrong_name' }], [400, { error: 'bad_request' }], [502, null], [418, 'teapot']] as const) {
      expect(readDeletionAnswer(status, body)).toEqual({ kind: 'try_again', closed: [] });
    }
  });

  it('says in plain words what happened, and that nothing was deleted when nothing was', () => {
    const at = { email: 'riley@example.com' };
    expect(deletionAnswerWords({ kind: 'wrong_password' }, at)).toBe('That is not the password for riley@example.com. Try again.');
    expect(deletionAnswerWords({ kind: 'password_needed' }, at)).toBe('Enter your password again. It has to be typed within ten minutes of deleting.');
    expect(deletionAnswerWords({ kind: 'last_supervisor', companies: ['Test Pit A'] }, at)).toBe('Test Pit A has no other supervisor now. Finish on the office dashboard.');
    expect(deletionAnswerWords({ kind: 'last_supervisor', companies: ['Test Pit A', 'Test Pit B'] }, at)).toBe('Test Pit A and Test Pit B have no other supervisor now. Finish on the office dashboard.');
    expect(deletionAnswerWords({ kind: 'unreachable' }, at)).toBe('Could not reach MineMuster’s server. Nothing was deleted. Try again when you have signal.');
    expect(deletionAnswerWords({ kind: 'try_again', closed: [] }, at)).toBe('MineMuster’s server could not delete your account just now. Nothing was deleted. Try again in a few minutes.');
    expect(deletionAnswerWords({ kind: 'try_again', closed: ['c-a'] }, at)).toBe('The company is closed, but your account could not be deleted just now. Try again in a few minutes.');
    expect(deletionAnswerWords({ kind: 'already_deleted' }, at)).toBe('Your company sign-in is already deleted. Delete the rest from this phone.');
    expect(deletionAnswerWords({ kind: 'not_ready' }, at)).toBe('Deleting a company sign-in is not ready on MineMuster’s server yet. Nothing was deleted. Try again later.');
    expect(deletionAnswerWords({ kind: 'too_many' }, at)).toBe('Too many tries for now. Wait a few minutes and try again. Nothing was deleted.');
    expect(deletionAnswerWords({ kind: 'signed_out' }, at)).toBe('MineMuster’s server did not take this phone’s sign-in. Nothing was deleted. Try again.');
    // Never "Nothing was deleted" when nobody can tell yet.
    expect(deletionAnswerWords({ kind: 'not_known', closed: [] }, at)).toBe('MineMuster’s server did not say in time whether your company sign-in was deleted. Try again in a minute.');
    expect(deletionAnswerWords({ kind: 'not_known', closed: ['c-a'] }, at)).toBe(
      'The company is closed. MineMuster’s server did not say in time whether your company sign-in was deleted too. Try again in a minute.',
    );
    for (const closed of [[], ['c-a']]) expect(deletionAnswerWords({ kind: 'not_known', closed }, at)).not.toMatch(/Nothing was deleted/);
  });

  it('reads a company the office dashboard asked to close and the server did not, with why and what went before it', () => {
    expect(readDeletionAnswer(409, { error: 'close_refused', company_id: 'c-b', reason: 'wrong_name', close_from: null, closed: ['c-a'] })).toEqual({
      kind: 'close_refused',
      companyId: 'c-b',
      reason: 'wrong_name',
      closeFrom: null,
      closed: ['c-a'],
    });
    expect(readDeletionAnswer(409, { error: 'close_refused', company_id: 'c-b', reason: 'someone_can_take_over', close_from: '2026-12-20T18:00:00+00:00', closed: [] })).toMatchObject({
      reason: 'someone_can_take_over',
      closeFrom: '2026-12-20T18:00:00+00:00',
    });
    // A reason this version does not know is no answer it can act on.
    expect(readDeletionAnswer(409, { error: 'close_refused', company_id: 'c-b', reason: 'later', closed: [] })).toEqual({ kind: 'try_again', closed: [] });
    const at = { email: 'riley@example.com' };
    const refused = (reason: 'wrong_name' | 'someone_can_take_over' | 'subscription_running' | 'not_found', closed: string[] = []) =>
      deletionAnswerWords({ kind: 'close_refused', companyId: 'c-b', reason, closeFrom: null, closed }, at);
    expect(refused('wrong_name')).toBe('Nothing was closed or deleted. Type the company’s name as it is written to close it.');
    expect(refused('subscription_running')).toBe('Nothing was closed or deleted. The company’s subscription is still running. Cancel it in Billing first.');
    expect(refused('someone_can_take_over', ['c-a'])).toBe(
      'The company before it is closed, and your account is not deleted yet. Someone else could still take over the company, so it was not closed. Make them a supervisor on the Roster page instead.',
    );
    expect(refused('not_found')).toBe('Nothing was closed or deleted. That company is not one you can close.');
  });

  it('settles an answer that does not say whether the sign-in went by asking Supabase Auth, and leaves every other answer as it is', async () => {
    const asked: string[] = [];
    const state = (s: 'gone' | 'there' | 'unknown') => async () => {
      asked.push(s);
      return s;
    };
    expect(await settleDeletion({ kind: 'not_known', closed: ['c-a'] }, state('gone'))).toEqual({ kind: 'deleted', closed: ['c-a'] });
    expect(await settleDeletion({ kind: 'not_known', closed: [] }, state('there'))).toEqual({ kind: 'not_known', closed: [] });
    expect(await settleDeletion({ kind: 'not_known', closed: [] }, state('unknown'))).toEqual({ kind: 'not_known', closed: [] });
    // A plain 401 was turned down before anything was deleted: gone means deleted from somewhere else.
    expect(await settleDeletion({ kind: 'signed_out' }, state('gone'))).toEqual({ kind: 'already_deleted' });
    expect(await settleDeletion({ kind: 'signed_out' }, state('there'))).toEqual({ kind: 'try_again', closed: [] });
    expect(await settleDeletion({ kind: 'signed_out' }, state('unknown'))).toEqual({ kind: 'try_again', closed: [] });
    expect(asked).toHaveLength(6);
    const plain: DeletionAnswer[] = [{ kind: 'deleted', closed: [] }, { kind: 'wrong_password' }, { kind: 'try_again', closed: ['c-a'] }, { kind: 'last_supervisor', companies: ['Test Pit A'] }];
    for (const answer of plain) expect(await settleDeletion(answer, state('gone'))).toEqual(answer);
    expect(asked).toHaveLength(6);
  });
});
