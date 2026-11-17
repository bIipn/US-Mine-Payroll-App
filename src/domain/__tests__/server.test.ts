import { connectProblem, otherCompany, parseServer } from '../server';
import {
  authWords,
  checkEmail,
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
  readJoinAnswer,
  readPushAnswer,
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
    expect(checkJoinCode('')).toMatch(/Enter the join code/);
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
    expect(say({ status: 'no_company' })).toMatchObject({ title: 'No company has that join code', tone: 'warn' });
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

  it('counts what the server took and what it will not take from this account, so neither is sent again', () => {
    const answer = {
      accepted: [{ key: 'shift:s1', rev: 'r1', conflict: true }, { key: 'leave:l1', rev: 'deleted' }],
      ignored: [{ key: 'employee:e1', rev: 'r2', reason: 'supervisor_only' }],
    };
    expect(readPushAnswer(answer, batch)).toEqual([
      { key: 'shift:s1', rev: 'r1' },
      { key: 'leave:l1', rev: 'deleted' },
      { key: 'employee:e1', rev: 'r2' },
    ]);
  });

  it('only counts what was in the batch, at the version that was sent', () => {
    const answer = {
      accepted: [{ key: 'shift:s1', rev: 'other' }, { key: 'shift:s9', rev: 'r9' }, { key: 'employee:e1', rev: 'r2' }, { key: 'employee:e1', rev: 'r2' }, 'junk', null],
    };
    expect(readPushAnswer(answer, batch)).toEqual([{ key: 'employee:e1', rev: 'r2' }]);
    expect(readPushAnswer({ accepted: [] }, batch)).toEqual([]);
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
