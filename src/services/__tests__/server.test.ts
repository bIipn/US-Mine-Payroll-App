import type { SupabaseClient } from '@supabase/supabase-js';

import type { Change } from '../../domain/sync';

// A made-up project: no request leaves the test.
jest.mock('../../config', () => ({ SERVER: { url: 'https://example.supabase.co', key: 'sb_publishable_test' } }));

const mockRpc = jest.fn();
const mockAuth = {
  signInWithPassword: jest.fn(),
  signUp: jest.fn(),
  signOut: jest.fn(),
  getSession: jest.fn(),
  setSession: jest.fn(),
  onAuthStateChange: jest.fn(),
  startAutoRefresh: jest.fn(),
  stopAutoRefresh: jest.fn(),
  resend: jest.fn(),
  resetPasswordForEmail: jest.fn(),
  getUser: jest.fn(),
};
/** supabase-js's edge function client: invoke(name, options). */
const mockInvoke = jest.fn();
/** A read of one table: each call of the chain is noted, and the read answers with `mockTable`'s answer. */
const mockReads: { table: string; calls: [string, unknown[]][]; signal?: AbortSignal }[] = [];
let mockTable: (table: string) => { data: unknown; error: unknown; status?: number } = () => ({ data: null, error: null });
const mockFrom = jest.fn((table: string) => {
  const read: (typeof mockReads)[number] = { table, calls: [] };
  mockReads.push(read);
  const chain: Record<string, unknown> = {};
  for (const step of ['select', 'eq', 'maybeSingle']) chain[step] = (...args: unknown[]) => (read.calls.push([step, args]), chain);
  chain.abortSignal = (signal: AbortSignal) => ((read.signal = signal), chain);
  chain.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(mockTable(table)).then(ok, fail);
  return chain;
});
/** The stand-in client the tests talk to, but for the one that runs supabase-js itself. */
const fakeClient = (..._args: unknown[]) => ({ rpc: mockRpc, auth: mockAuth, from: mockFrom, functions: { invoke: mockInvoke } });
const mockCreateClient = jest.fn<unknown, unknown[]>(fakeClient);
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../server') as typeof import('../server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { safeStorage } = require('../storage') as typeof import('../storage');

/**
 * The phone's own requests that do not go through the stand-in client: the crew-auth function's, and
 * supabase-js's in the test that runs it. Every one is answered here; none leaves the test.
 */
const realFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
/** An answer as fetch hands it back. */
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A request the phone sent: where, how, its headers and its body. */
function sent(n = 0) {
  const [url, init] = mockFetch.mock.calls[n];
  return { url, method: init.method, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as unknown, signal: init.signal };
}

// This project has no Node types, so the file system is asked for by name with the calls used here.
type Entry = { name: string; isDirectory(): boolean };
const fs = jest.requireActual<{ readdirSync(dir: string, o: { withFileTypes: true }): Entry[]; readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));
const src = `${root}/src`;

const change = (key: string, rev: string, record: unknown = { id: key }): Change => {
  const [kind, id] = key.split(':');
  return { key, kind: kind as Change['kind'], id, rev, record };
};

/** What supabase-js tells the client's listener, the way it would. */
let authEvent: (event: string, session: unknown) => void = () => undefined;
const unsubscribe = jest.fn();
const AVERY = { id: 'u-avery', email: 'avery@example.com' };
/** Avery's account as the phone has it: one that signs in with email. */
const AVERY_ACCOUNT = { ...AVERY, kind: 'email' as const };
const sessionOf = (user: { id: string; email: string }) => ({ access_token: 'a', refresh_token: 'r', user });
const offline = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };
/**
 * A crew member's account, as crew-auth makes it: a hidden address nobody sees or types, and the mark
 * in app_metadata, which only the server can write.
 */
const SAM_USER = {
  id: 'u-sam',
  aud: 'authenticated',
  email: 'crew-5f0c8e2a9b7d4c1e8a6f3b2d1c0e9f8a@crew.minemuster.com',
  app_metadata: { provider: 'email', providers: ['email'], sign_in: 'passcode' },
  user_metadata: {},
};
const SAM = { id: 'u-sam', email: SAM_USER.email, kind: 'passcode' as const };

beforeEach(() => {
  mockRpc.mockReset();
  mockInvoke.mockReset();
  Object.values(mockAuth).forEach((f) => f.mockReset());
  unsubscribe.mockReset();
  mockAuth.onAuthStateChange.mockImplementation((cb: (event: string, session: unknown) => void) => {
    authEvent = cb;
    return { data: { subscription: { unsubscribe } } };
  });
  mockAuth.getSession.mockResolvedValue({ data: { session: sessionOf(AVERY) }, error: null });
});

describe('the client', () => {
  it('keeps the session on the phone and never looks for one in a link', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await server.myCompanies();
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = mockCreateClient.mock.calls[0] as [string, string, { auth: Record<string, unknown> }];
    expect(url).toBe('https://example.supabase.co');
    expect(key).toBe('sb_publishable_test');
    expect(options.auth).toMatchObject({ persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'minemuster-server-session' });
    // The session goes into the app's own storage and comes back out of it.
    const storage = options.auth.storage as { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> };
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });
});

describe('the account', () => {
  it('signs in with the email in lower case, and says when it does not match', async () => {
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: sessionOf(AVERY) }, error: null });
    expect(await server.signIn(' Avery@Example.com ', 'haulroad88')).toEqual({ ok: true, account: AVERY_ACCOUNT });
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'avery@example.com', password: 'haulroad88' });
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null }, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } });
    expect(await server.signIn('avery@example.com', 'wrong')).toEqual({ ok: false, error: 'That email and password do not match an account. Check the spelling, or tap Forgot password.' });
    mockAuth.signInWithPassword.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await server.signIn('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, error: expect.stringMatching(/could not be reached/) });
  });

  it('says to confirm the email when a new account has no session yet, and when the email already has an account', async () => {
    mockAuth.signUp.mockResolvedValueOnce({ data: { user: { email: 'avery@example.com', identities: [{ id: 'i1' }] }, session: null }, error: null });
    expect(await server.signUp('avery@example.com', 'haulroad88')).toEqual({ ok: true, confirm: true });
    mockAuth.signUp.mockResolvedValueOnce({ data: { user: {}, session: { user: {} } }, error: null });
    expect(await server.signUp('avery@example.com', 'haulroad88')).toEqual({ ok: true, confirm: false });
    mockAuth.signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: { code: 'weak_password', status: 422 } });
    expect(await server.signUp('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, error: expect.stringMatching(/stronger password/) });
    // With email confirmation on, an address that already has an account comes back as a user with no identities, and no email is sent.
    mockAuth.signUp.mockResolvedValueOnce({ data: { user: { email: 'avery@example.com', identities: [] }, session: null }, error: null });
    expect(await server.signUp('avery@example.com', 'haulroad88')).toEqual({ ok: false, error: 'That email already has an account. Sign in, or tap Forgot password.' });
  });

  it('sends the link to set a new password, and the confirmation link again', async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    expect(await server.resetPassword(' Avery@Example.com ')).toEqual({ ok: true });
    expect(mockAuth.resetPasswordForEmail).toHaveBeenCalledWith('avery@example.com');
    mockAuth.resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: { status: 429, message: 'slow down' } });
    expect(await server.resetPassword('avery@example.com')).toMatchObject({ ok: false, error: expect.stringMatching(/Too many tries/) });
    mockAuth.resend.mockResolvedValueOnce({ data: {}, error: null });
    expect(await server.resendConfirmation('avery@example.com')).toEqual({ ok: true });
    expect(mockAuth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'avery@example.com' });
  });

  it('signs out of this phone only, and takes the session off the phone even with no signal', async () => {
    await server.myCompanies().catch(() => undefined);
    const heard: (string | null)[] = [];
    const stop = server.onAccountChange((account) => heard.push(account?.email ?? null));
    await new Promise((r) => setTimeout(r, 0));
    await safeStorage.setItem('minemuster-server-session', JSON.stringify(sessionOf(AVERY)));
    await safeStorage.setItem('minemuster-server-session-user', '{}');
    await safeStorage.setItem('us-mine-crew-records', '{"kept":true}');
    // No signal and an expired session: supabase-js answers with an error, signs nothing out and keeps the session.
    mockAuth.signOut.mockResolvedValueOnce({ error: offline });
    await server.signOut();
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await safeStorage.getItem('minemuster-server-session')).toBeNull();
    expect(await safeStorage.getItem('minemuster-server-session-user')).toBeNull();
    // Nothing else of the app's is touched.
    expect(await safeStorage.getItem('us-mine-crew-records')).toBe('{"kept":true}');
    // Everyone listening hears that nobody is signed in, and the client that held the session is let go.
    expect(heard).toEqual(['avery@example.com', null]);
    expect(unsubscribe).toHaveBeenCalled();
    expect(mockAuth.stopAutoRefresh).toHaveBeenCalled();
    const made = mockCreateClient.mock.calls.length;
    mockRpc.mockResolvedValue({ data: [], error: null });
    await server.myCompanies();
    expect(mockCreateClient.mock.calls.length).toBe(made + 1);
    // A sign-out that throws is no different.
    mockAuth.signOut.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await safeStorage.setItem('minemuster-server-session', '{}');
    await expect(server.signOut()).resolves.toBeUndefined();
    expect(await safeStorage.getItem('minemuster-server-session')).toBeNull();
    stop();
  });

  it('hears who is signed in, straight away and when it changes, until told to stop', async () => {
    await server.myCompanies().catch(() => undefined);
    const heard: (string | null)[] = [];
    const stop = server.onAccountChange((account) => heard.push(account?.email ?? null));
    await new Promise((r) => setTimeout(r, 0));
    // The first reading is the phone's own; supabase-js's is not taken, since with no signal it says nobody.
    authEvent('INITIAL_SESSION', null);
    authEvent('SIGNED_OUT', null);
    authEvent('SIGNED_IN', sessionOf({ id: 'u-blake', email: 'blake@example.com' }));
    stop();
    authEvent('SIGNED_IN', sessionOf({ id: 'u-late', email: 'late@example.com' }));
    expect(heard).toEqual(['avery@example.com', null, 'blake@example.com']);
  });

  it('counts a session it cannot refresh with no signal as still signed in', async () => {
    await safeStorage.setItem('minemuster-server-session', JSON.stringify(sessionOf(AVERY)));
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: offline });
    const heard: unknown[] = [];
    const stop = server.onAccountChange((account) => heard.push(account));
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).toEqual([AVERY_ACCOUNT]);
    stop();
    // A session the server turned down is gone: nobody is signed in.
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthApiError', code: 'refresh_token_not_found', status: 400 } });
    const later: unknown[] = [];
    const stop2 = server.onAccountChange((account) => later.push(account));
    await new Promise((r) => setTimeout(r, 0));
    expect(later).toEqual([null]);
    stop2();
    await safeStorage.removeItem('minemuster-server-session');
  });
});

describe('crew sign-in by passcode', () => {
  afterEach(() => jest.useRealTimers());

  it('crewAuth posts JSON with no Origin and answers unreachable after 30 seconds', async () => {
    jest.useFakeTimers();
    // An answer that never comes.
    mockFetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    let answer: unknown = 'none yet';
    void server.crewAuth('sign_in', { code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582039' }).then((a) => (answer = a));
    await jest.advanceTimersByTimeAsync(29_999);
    expect(answer).toBe('none yet');
    const asked = sent();
    expect(asked).toMatchObject({ url: 'https://example.supabase.co/functions/v1/crew-auth', method: 'POST' });
    // The action and exactly the fields given, under the server's own names: crew-auth turns down any other.
    expect(asked.body).toEqual({ action: 'sign_in', code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', passcode: '582039' });
    expect(asked.headers.get('content-type')).toBe('application/json');
    expect(asked.headers.get('apikey')).toBe('sb_publishable_test');
    // No Origin, which crew-auth turns down as a web page's; and no bearer, since none was given.
    expect(asked.headers.has('origin')).toBe(false);
    expect(asked.headers.has('authorization')).toBe(false);
    expect(asked.signal?.aborted).toBe(false);
    // Thirty seconds and no answer: the request is aborted, and the server could not be reached.
    await jest.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ kind: 'unreachable' });
    expect(asked.signal?.aborted).toBe(true);
    jest.useRealTimers();

    // The passcode of the account signed in here is confirmed with that account's own token as the bearer.
    mockFetch.mockResolvedValueOnce(reply(200, { status: 'wrong', tries_left: 4 }));
    expect(await server.crewAuth('confirm', { passcode: '582039' }, 'a-sam')).toEqual({ kind: 'wrong', triesLeft: 4 });
    expect(sent(1).body).toEqual({ action: 'confirm', passcode: '582039' });
    expect(sent(1).headers.get('authorization')).toBe('Bearer a-sam');
    expect(sent(1).headers.has('origin')).toBe(false);
    // What crew-auth answers is read by its status and its body; with no signal, it could not be reached.
    mockFetch.mockResolvedValueOnce(reply(200, { status: 'company', name: 'Test Pit A', state: 'NV' }));
    expect(await server.crewAuth('lookup', { code: 'ABCD2345' })).toEqual({ kind: 'company', name: 'Test Pit A', state: 'NV' });
    expect(sent(2).body).toEqual({ action: 'lookup', code: 'ABCD2345' });
    mockFetch.mockResolvedValueOnce(reply(410, { error: 'already_deleted', message: 'This sign-in is deleted already.' }));
    expect(await server.crewAuth('confirm', { passcode: '582039' }, 'a-sam')).toEqual({ kind: 'already_deleted' });
    mockFetch.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await server.crewAuth('lookup', { code: 'ABCD2345' })).toEqual({ kind: 'server', message: expect.stringMatching(/HTTP 502/) });
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await server.crewAuth('lookup', { code: 'ABCD2345' })).toEqual({ kind: 'unreachable' });
  });

  it('crewAuth takes each action’s own fields, under the server’s names, and no other', () => {
    // Each ask below is a compile error, which `npm run typecheck` holds: it fails on any of these lines
    // that is not one. None is ever sent, since nothing calls the function that holds them.
    const neverSent = () => [
      // @ts-expect-error A camelCase name: crew-auth takes first_name and last_name.
      server.crewAuth('sign_in', { code: 'ABCD2345', firstName: 'Sam', lastName: 'Ortiz', passcode: '582039' }),
      // @ts-expect-error A field left out: signing in takes the passcode too.
      server.crewAuth('sign_in', { code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz' }),
      // @ts-expect-error A field too many: a lookup takes the code alone.
      server.crewAuth('lookup', { code: 'ABCD2345', passcode: '582039' }),
      // @ts-expect-error Another action's fields: a confirm takes the passcode alone.
      server.crewAuth('confirm', { code: 'ABCD2345' }),
      // @ts-expect-error A reset's names are reset_code and new_passcode.
      server.crewAuth('reset', { code: 'ABCD2345', first_name: 'Sam', last_name: 'Ortiz', resetCode: '204913', newPasscode: '582039' }),
    ];
    expect(typeof neverSent).toBe('function');
    expect(mockFetch).not.toHaveBeenCalled();

    // The fields, action by action, are the ones crew-auth takes (FIELDS in its handler).
    const fieldsIn = (block: string, field: RegExp) =>
      Object.fromEntries(
        block
          .split('\n')
          .map((line) => /^\s*(\w+): (.*)$/.exec(line))
          .filter((m): m is RegExpExecArray => m !== null)
          .map(([, action, rest]) => [action, [...rest.matchAll(field)].map((m) => m[1]).sort()]),
      );
    const app = /export interface CrewFields \{\n([\s\S]*?)\n\}/.exec(fs.readFileSync(`${src}/domain/serverAnswers.ts`, 'utf8'));
    const handler = /const FIELDS: [^=]+= \{\n([\s\S]*?)\n\};/.exec(fs.readFileSync(`${root}/supabase/functions/crew-auth/handler.ts`, 'utf8'));
    const theirs = fieldsIn(handler?.[1] ?? '', /'(\w+)'/g);
    expect(Object.keys(theirs)).toEqual(['lookup', 'sign_up', 'sign_in', 'reset', 'confirm']);
    expect(fieldsIn(app?.[1] ?? '', /(\w+): string/g)).toEqual(theirs);
  });

  it('startCrewSession hands the tokens to the client and reads the account kind', async () => {
    const crewSession = { accessToken: 'a-sam', refreshToken: 'r-sam', expiresAt: 1_795_000_000, userId: 'u-sam' };
    mockAuth.setSession.mockResolvedValueOnce({ data: { user: SAM_USER, session: { access_token: 'a-sam', refresh_token: 'r-sam', user: SAM_USER } }, error: null });
    expect(await server.startCrewSession(crewSession)).toEqual({ ok: true, account: SAM });
    expect(mockAuth.setSession).toHaveBeenCalledWith({ access_token: 'a-sam', refresh_token: 'r-sam' });
    // An account that signs in with email is one whatever else its app_metadata holds.
    const avery = { ...AVERY, app_metadata: { provider: 'email', providers: ['email'] } };
    mockAuth.setSession.mockResolvedValueOnce({ data: { user: avery, session: { access_token: 'a', refresh_token: 'r', user: avery } }, error: null });
    expect(await server.startCrewSession({ ...crewSession, userId: AVERY.id })).toEqual({ ok: true, account: AVERY_ACCOUNT });
    // With no signal nothing is kept, and the person is told why.
    mockAuth.setSession.mockResolvedValueOnce({ data: { user: null, session: null }, error: offline });
    expect(await server.startCrewSession(crewSession)).toEqual({ ok: false, error: 'The company server could not be reached. Check your signal and try again.' });

    // Whoever listens hears the kind too: from the session the phone holds, and from supabase-js.
    mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'a-sam', refresh_token: 'r-sam', user: SAM_USER } }, error: null });
    const heard: unknown[] = [];
    const stop = server.onAccountChange((account) => heard.push(account));
    await new Promise((r) => setTimeout(r, 0));
    authEvent('TOKEN_REFRESHED', { access_token: 'a-2', refresh_token: 'r-2', user: SAM_USER });
    authEvent('SIGNED_IN', sessionOf(AVERY));
    stop();
    expect(heard).toEqual([SAM, SAM, AVERY_ACCOUNT]);
  });
});

describe('the company', () => {
  it('joins with the code and the name, and reads the answer', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'pending', company_name: 'Test Pit A', reason: 'not_on_roster' }, error: null });
    expect(await server.joinCompany('ABCD2345', 'Blake', 'Rook')).toEqual({
      ok: true,
      answer: { status: 'pending', companyName: 'Test Pit A', reason: 'not_on_roster' },
    });
    expect(mockRpc).toHaveBeenCalledWith('join_company', { code: 'ABCD2345', first_name: 'Blake', last_name: 'Rook' });
  });

  it('says what went wrong when the server refuses', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'name not allowed' } });
    expect(await server.joinCompany('ABCD2345', 'B​lake', 'Rook')).toMatchObject({ ok: false, error: expect.stringMatching(/ordinary letters/) });
    mockRpc.mockResolvedValueOnce({ data: { status: 'surprise' }, error: null });
    expect(await server.joinCompany('ABCD2345', 'Blake', 'Rook')).toMatchObject({ ok: false });
    mockRpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await server.joinCompany('ABCD2345', 'Blake', 'Rook')).toMatchObject({ ok: false, error: expect.stringMatching(/could not be reached/) });
  });

  it('lists the companies the account is on', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ id: 'c-a', name: 'Test Pit A', state: 'NV', role: 'employee' }], error: null });
    expect(await server.myCompanies()).toEqual({ ok: true, companies: [{ id: 'c-a', name: 'Test Pit A', state: 'NV', role: 'employee' }] });
    expect(mockRpc).toHaveBeenCalledWith('my_companies');
  });
});

describe('sending records', () => {
  const batch = [change('shift:s1', 'r1'), change('employee:e1', 'r2'), change('leave:l1', 'deleted', null)];

  it('sends the batch to the company and answers with what was taken, and what is held for this sign-in', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { accepted: [{ key: 'shift:s1', rev: 'r1' }, { key: 'leave:l1', rev: 'deleted' }], ignored: [{ key: 'employee:e1', rev: 'r2', reason: 'supervisor_only' }] },
      error: null,
    });
    const link = server.pushTransport('c-a');
    expect(link.company).toBe('c-a');
    const took = await link.push(batch);
    expect(mockRpc).toHaveBeenCalledWith('push_records', { company_id: 'c-a', changes: batch });
    expect(took).toEqual({
      took: [{ key: 'shift:s1', rev: 'r1' }, { key: 'leave:l1', rev: 'deleted' }],
      stale: [],
      floored: [],
      held: [{ key: 'employee:e1', rev: 'r2', reason: 'supervisor_only' }],
    });
  });

  it('hands the call a signal that can stop it', async () => {
    const abortSignal = jest.fn(async () => ({ data: { accepted: [], ignored: [] }, error: null }));
    mockRpc.mockReturnValueOnce({ abortSignal });
    const stop = new AbortController();
    await server.pushTransport('c-a').push(batch, stop.signal);
    expect(abortSignal).toHaveBeenCalledWith(stop.signal);
  });

  it('sends nothing without a session, and says the phone is signed out', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'signed_out' });
    // A session the server turned down is the same: sign in again.
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthApiError', code: 'refresh_token_not_found', status: 400 } });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'signed_out' });
    // With no signal to refresh it, the call waits for signal.
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: offline });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'unreachable' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('says why the server did not take the batch, so the phone knows whether to try again', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not a member' } });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'not_member' });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'malformed change' } });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'refused' });
    mockRpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'unreachable' });
    // A server that is down says so with the answer's status.
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'bad gateway' }, status: 502 });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toMatchObject({ trouble: 'unreachable' });
    mockRpc.mockResolvedValueOnce({ data: 'ok', error: null });
    await expect(server.pushTransport('c-a').push(batch)).rejects.toThrow(/does not understand/);
  });
});

describe('the requests that wait', () => {
  it('lists the account’s requests that still wait for a supervisor', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ id: 'r1', company_id: 'c-a', first_name: 'Blake', last_name: 'Rook', status: 'pending', created_at: '2026-11-12T14:00:00Z' }], error: null });
    expect(await server.myJoinRequests()).toMatchObject({ ok: true, requests: [{ id: 'r1', companyId: 'c-a' }] });
    expect(mockRpc).toHaveBeenCalledWith('my_join_requests');
  });
});

describe('reading the company’s records', () => {
  beforeEach(() => {
    mockReads.length = 0;
    mockTable = () => ({ data: null, error: null });
  });

  it('reads the four kinds after the cursor, through read_shared_records', async () => {
    const row = { kind: 'equipment', id: 'eq_t14', rev: 'r1', seq: 8, deleted: false, data: { id: 'eq_t14' } };
    mockRpc.mockResolvedValueOnce({ data: [row], error: null });
    const link = server.companyTransport('c-a');
    expect(await link.pull!(7, 200)).toEqual([row]);
    expect(mockRpc).toHaveBeenCalledWith('read_shared_records', { company_id: 'c-a', after: 7, max: 200 });
  });

  it('says MineMuster stopped for the company, and reads nothing without a session', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PT402', message: 'MineMuster is not active for this company.' }, status: 402 });
    await expect(server.companyTransport('c-a').pull!(0, 200)).rejects.toMatchObject({ trouble: 'closed' });
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(server.companyTransport('c-a').pull!(0, 200)).rejects.toMatchObject({ trouble: 'signed_out' });
    await expect(server.companyTransport('c-a').standing!()).rejects.toMatchObject({ trouble: 'signed_out' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('reads the sign-in’s own row of the roster, and none as not on the roster', async () => {
    mockTable = () => ({ data: { first_name: 'Avery', last_name: 'Quill', role: 'supervisor' }, error: null });
    const stop = new AbortController();
    expect(await server.companyTransport('c-a').standing!(stop.signal)).toEqual({ role: 'supervisor', name: { firstName: 'Avery', lastName: 'Quill' } });
    expect(mockReads[0]).toMatchObject({ table: 'roster', signal: stop.signal });
    expect(mockReads[0].calls).toEqual([
      ['select', ['first_name,last_name,role']],
      ['eq', ['company_id', 'c-a']],
      ['eq', ['user_id', AVERY.id]],
      ['maybeSingle', []],
    ]);
    mockTable = () => ({ data: null, error: null });
    expect(await server.companyTransport('c-a').standing!()).toBeNull();
    mockTable = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    await expect(server.companyTransport('c-a').standing!()).rejects.toMatchObject({ trouble: 'unreachable' });
  });

  it('reads the company’s own row', async () => {
    mockTable = () => ({ data: { name: 'Test Pit A', state: 'NV', pay_period: null }, error: null });
    expect(await server.companyTransport('c-a').companyRow!()).toEqual({ name: 'Test Pit A', state: 'NV', pay: null });
    expect(mockReads[0].table).toBe('companies');
    expect(mockReads[0].calls).toEqual([['select', ['name,state,pay_period']], ['eq', ['id', 'c-a']], ['maybeSingle', []]]);
  });
});

describe('checking the company sign-in’s password', () => {
  it('says whether it is right, and asks for signal when the server cannot be reached', async () => {
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: sessionOf(AVERY), user: AVERY }, error: null });
    expect(await server.checkPassword('avery@example.com', 'right-password')).toEqual({ ok: true });
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'avery@example.com', password: 'right-password' });
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } });
    expect(await server.checkPassword('avery@example.com', 'wrong')).toEqual({ ok: false, error: 'That is not the password for avery@example.com. Try again.' });
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: offline });
    expect(await server.checkPassword('avery@example.com', 'x')).toEqual({
      ok: false,
      error: 'Making a supervisor’s account needs signal once, to check your company sign-in. Try again when you have signal.',
    });
  });
});

describe('deleting the company sign-in', () => {
  /** The function's answer when it is not 2xx, as supabase-js hands it back: a FunctionsHttpError holding the response. */
  const httpError = (status: number, body: unknown) => ({
    data: null,
    error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } },
  });
  const signedIn = () => mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: sessionOf(AVERY), user: AVERY }, error: null });
  const wrong = { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' };

  it('checks the password again first, then asks the server to delete the account the session is, naming nobody', async () => {
    signedIn();
    mockInvoke.mockResolvedValueOnce({ data: { deleted: true, closed: [] }, error: null });
    expect(await server.deleteAccount(' Avery@Example.com ', 'haulroad88')).toEqual({ ok: true, closed: [] });
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'avery@example.com', password: 'haulroad88' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [name, options] = mockInvoke.mock.calls[0] as [string, { body: unknown; timeout: number }];
    expect(name).toBe('delete-account');
    // The body names no account: the server deletes the one the session is.
    expect(options.body).toEqual({});
    expect(options.timeout).toBe(server.DELETE_TIMEOUT_MS);
    expect(mockAuth.signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
    // Nothing is signed out here: connection.ts does that, once the phone has stopped sending.
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('says the password is wrong, or that the sign-in was deleted already, and asks the server nothing', async () => {
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: wrong });
    mockAuth.getUser.mockResolvedValueOnce({ data: { user: AVERY }, error: null });
    expect(await server.deleteAccount('avery@example.com', 'wrong')).toEqual({
      ok: false,
      answer: { kind: 'wrong_password' },
      error: 'That is not the password for avery@example.com. Try again.',
    });
    // Supabase Auth answers a deleted account's password the same way; the session the phone still holds says which.
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: wrong });
    mockAuth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found', status: 403, message: 'User from sub claim in JWT does not exist' } });
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, answer: { kind: 'already_deleted' } });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('needs signal, and says when there have been too many tries', async () => {
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: offline });
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toEqual({
      ok: false,
      answer: { kind: 'unreachable' },
      error: 'Could not reach MineMuster’s server. Nothing was deleted. Try again when you have signal.',
    });
    mockAuth.signInWithPassword.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ answer: { kind: 'unreachable' } });
    mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { name: 'AuthApiError', code: 'over_request_rate_limit', status: 429 } });
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ answer: { kind: 'too_many' } });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  const gone = { data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found', status: 403, message: 'User from sub claim in JWT does not exist' } };
  const there = { data: { user: AVERY }, error: null };
  const fetchFailed = { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } };

  it('reads what the server answered', async () => {
    const cases: [unknown, unknown][] = [
      [httpError(409, { error: 'last_supervisor', companies: [{ id: 'c-a', name: 'Test Pit A', successors: [] }] }), { kind: 'last_supervisor', companies: ['Test Pit A'] }],
      [httpError(403, { error: 'password_needed' }), { kind: 'password_needed' }],
      [httpError(410, { error: 'already_deleted' }), { kind: 'already_deleted' }],
      [httpError(500, { error: 'try_again', closed: [] }), { kind: 'try_again', closed: [] }],
      [httpError(404, { code: 'NOT_FOUND' }), { kind: 'not_ready' }],
      [{ data: { deleted: false }, error: null }, { kind: 'try_again', closed: [] }],
    ];
    for (const [reply, answer] of cases) {
      signedIn();
      mockInvoke.mockResolvedValueOnce(reply);
      expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, answer });
    }
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('asks Supabase Auth before it says a plain 401 means deleted: never a deletion on its word alone', async () => {
    // The function turned the session down before deleting anything. Still there: nothing was deleted.
    signedIn();
    mockInvoke.mockResolvedValueOnce(httpError(401, { error: 'signed_out' }));
    mockAuth.getUser.mockResolvedValueOnce(there);
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toEqual({
      ok: false,
      answer: { kind: 'try_again', closed: [] },
      error: 'MineMuster’s server could not delete your account just now. Nothing was deleted. Try again in a few minutes.',
    });
    // Nobody can tell: still nothing was deleted by this request.
    signedIn();
    mockInvoke.mockResolvedValueOnce(httpError(401, { message: 'Invalid JWT' }));
    mockAuth.getUser.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, answer: { kind: 'try_again' } });
    // Gone: deleted from somewhere else.
    signedIn();
    mockInvoke.mockResolvedValueOnce(httpError(401, { error: 'signed_out' }));
    mockAuth.getUser.mockResolvedValueOnce(gone);
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, answer: { kind: 'already_deleted' } });
  });

  it('when the request may have gone with no answer, says deleted only once Supabase Auth has no such account, and never that nothing was deleted', async () => {
    const unanswered: unknown[] = [
      fetchFailed,
      { data: null, error: { name: 'FunctionsRelayError', message: 'Relay Error invoking the Edge Function' } },
      httpError(504, { error: 'not_known', closed: [] }),
    ];
    for (const reply of unanswered) {
      signedIn();
      mockInvoke.mockResolvedValueOnce(reply);
      mockAuth.getUser.mockResolvedValueOnce(gone);
      expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toEqual({ ok: true, closed: [] });

      signedIn();
      mockInvoke.mockResolvedValueOnce(reply);
      mockAuth.getUser.mockResolvedValueOnce(there);
      const still = await server.deleteAccount('avery@example.com', 'haulroad88');
      expect(still).toMatchObject({ ok: false, answer: { kind: 'not_known', closed: [] } });
      expect(still.ok ? '' : still.error).not.toMatch(/Nothing was deleted/);
    }
    // The phone gave up waiting (its own timeout aborts the call), and Auth cannot be asked either.
    signedIn();
    mockInvoke.mockRejectedValueOnce(new Error('The operation was aborted.'));
    mockAuth.getUser.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toMatchObject({ ok: false, answer: { kind: 'not_known' } });
    // The companies closed before the answer was lost are still said.
    signedIn();
    mockInvoke.mockResolvedValueOnce(httpError(504, { error: 'not_known', closed: ['c-a'] }));
    mockAuth.getUser.mockResolvedValueOnce(gone);
    expect(await server.deleteAccount('avery@example.com', 'haulroad88')).toEqual({ ok: true, closed: ['c-a'] });
  });

  it('reads what deleting the account means in each company, with a session only', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ id: 'c-a', name: 'Test Pit A', role: 'supervisor', last_supervisor: true, successors: [], can_close: true, close_from: null, running: 0 }],
      error: null,
    });
    expect(await server.deletionCheck()).toEqual({
      ok: true,
      companies: [{ id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], canClose: true, closeFrom: null, running: 0 }],
    });
    expect(mockRpc).toHaveBeenCalledWith('account_deletion_check');
    mockRpc.mockResolvedValueOnce({ data: { not: 'a list' }, error: null });
    expect(await server.deletionCheck()).toMatchObject({ ok: false });
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mockRpc.mockClear();
    expect(await server.deletionCheck()).toMatchObject({ ok: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  describe('with a passcode', () => {
    /** The session crew-auth's confirm answers: made just now, with the account's own password. */
    const fresh = { access_token: 'a-fresh', refresh_token: 'r-fresh', expires_at: 1_795_000_000, user_id: 'u-sam' };
    const confirmed = () => mockFetch.mockResolvedValueOnce(reply(200, { status: 'signed_in', session: fresh }));
    beforeEach(() => {
      mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: 'a-sam', refresh_token: 'r-sam', user: SAM_USER } }, error: null });
      mockAuth.setSession.mockResolvedValue({ data: { user: SAM_USER, session: { access_token: 'a-fresh', refresh_token: 'r-fresh', user: SAM_USER } }, error: null });
    });

    it('deleteAccountWithPasscode confirms the passcode for a fresh session, then calls delete-account', async () => {
      confirmed();
      mockInvoke.mockResolvedValueOnce({ data: { deleted: true, closed: [] }, error: null });
      expect(await server.deleteAccountWithPasscode('582039')).toEqual({ ok: true, closed: [] });
      // crew-auth checks the passcode of the account signed in here: its own token is the bearer.
      expect(sent().body).toEqual({ action: 'confirm', passcode: '582039' });
      expect(sent().headers.get('authorization')).toBe('Bearer a-sam');
      // The fresh session is the phone's from then on, and delete-account is asked with it, naming nobody.
      expect(mockAuth.setSession).toHaveBeenCalledWith({ access_token: 'a-fresh', refresh_token: 'r-fresh' });
      expect(mockInvoke).toHaveBeenCalledWith('delete-account', { body: {}, timeout: server.DELETE_TIMEOUT_MS });
      expect(mockFetch.mock.invocationCallOrder[0]).toBeLessThan(mockAuth.setSession.mock.invocationCallOrder[0]);
      expect(mockAuth.setSession.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
      // No email and no password anywhere; and nothing is signed out here: connection.ts does that.
      expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
      expect(mockAuth.signOut).not.toHaveBeenCalled();

      // What delete-account answers is read as it is after a password: checked with Supabase Auth when it does not say.
      confirmed();
      mockInvoke.mockResolvedValueOnce(fetchFailed);
      mockAuth.getUser.mockResolvedValueOnce(gone);
      expect(await server.deleteAccountWithPasscode('582039')).toEqual({ ok: true, closed: [] });
      confirmed();
      mockInvoke.mockResolvedValueOnce(httpError(401, { error: 'signed_out' }));
      mockAuth.getUser.mockResolvedValueOnce(there);
      expect(await server.deleteAccountWithPasscode('582039')).toEqual({
        ok: false,
        answer: { kind: 'try_again', closed: [] },
        error: 'MineMuster’s server could not delete your account just now. Nothing was deleted. Try again in a few minutes.',
      });
    });

    it('says why nothing was deleted, in the crew sign-in’s own words for a wrong or locked passcode', async () => {
      const tryAgain = {
        ok: false,
        answer: { kind: 'try_again', closed: [] },
        error: 'MineMuster’s server could not delete your account just now. Nothing was deleted. Try again in a few minutes.',
      };
      const cases: [Response | Error, unknown][] = [
        [reply(200, { status: 'wrong', tries_left: 4 }), { ok: false, answer: { kind: 'wrong_password' }, error: 'That passcode is not right. 4 tries left. Check it and try again.' }],
        [reply(200, { status: 'locked', until: null }), { ok: false, answer: { kind: 'too_many' }, error: 'This sign-in is locked. Ask a supervisor for a reset code.' }],
        [reply(200, { status: 'busy' }), { ok: false, answer: { kind: 'too_many' }, error: 'Too many tries for now. Wait a few minutes and try again. Nothing was deleted.' }],
        // crew-auth asked Supabase Auth whose the token is: turned down, or deleted already. Deletion's own reasons.
        [reply(401, { error: 'signed_out' }), { ok: false, answer: { kind: 'signed_out' }, error: 'MineMuster’s server did not take this phone’s sign-in. Nothing was deleted. Try again.' }],
        [reply(410, { error: 'already_deleted' }), { ok: false, answer: { kind: 'already_deleted' }, error: 'Your company sign-in is already deleted. Delete the rest from this phone.' }],
        [new TypeError('Network request failed'), { ok: false, answer: { kind: 'unreachable' }, error: 'Could not reach MineMuster’s server. Nothing was deleted. Try again when you have signal.' }],
        [reply(200, { status: 'no_account' }), tryAgain],
        [reply(500, { error: 'try_again' }), tryAgain],
        // A session for any other account is never taken: what is deleted is the account signed in here.
        [reply(200, { status: 'signed_in', session: { ...fresh, user_id: 'u-lee' } }), tryAgain],
      ];
      for (const [answer, result] of cases) {
        if (answer instanceof Error) mockFetch.mockRejectedValueOnce(answer);
        else mockFetch.mockResolvedValueOnce(answer);
        expect(await server.deleteAccountWithPasscode('582039')).toEqual(result);
      }
      expect(mockAuth.setSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
      // A lock that ends says when.
      mockFetch.mockResolvedValueOnce(reply(200, { status: 'locked', until: '2026-11-23T15:30:00Z' }));
      expect(await server.deleteAccountWithPasscode('582039')).toEqual({
        ok: false,
        answer: { kind: 'too_many' },
        error: expect.stringMatching(/^Too many wrong passcodes\. Try again at .+, or ask a supervisor for a reset code\.$/),
      });

      // With no session the phone can use, crew-auth is not asked at all.
      const noSignal = { ok: false, answer: { kind: 'unreachable' }, error: 'Could not reach MineMuster’s server. Nothing was deleted. Try again when you have signal.' };
      mockFetch.mockClear();
      mockAuth.getSession.mockResolvedValueOnce({ data: { session: null }, error: offline });
      expect(await server.deleteAccountWithPasscode('582039')).toEqual(noSignal);
      mockAuth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      expect(await server.deleteAccountWithPasscode('582039')).toMatchObject({ ok: false, answer: { kind: 'signed_out' } });
      // supabase-js failing outright while it reads the session is no different from no signal.
      mockAuth.getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      expect(await server.deleteAccountWithPasscode('582039')).toEqual(noSignal);
      expect(mockFetch).not.toHaveBeenCalled();
      // A fresh session supabase-js could not take, or one it finds is another account's: nothing is asked of delete-account.
      confirmed();
      mockAuth.setSession.mockResolvedValueOnce({ data: { user: null, session: null }, error: offline });
      expect(await server.deleteAccountWithPasscode('582039')).toEqual(noSignal);
      // Turned down, rather than unanswered: try again.
      confirmed();
      mockAuth.setSession.mockResolvedValueOnce({ data: { user: null, session: null }, error: { name: 'AuthApiError', code: 'bad_jwt', status: 403, message: 'invalid JWT' } });
      expect(await server.deleteAccountWithPasscode('582039')).toEqual(tryAgain);
      const lee = { ...SAM_USER, id: 'u-lee' };
      confirmed();
      mockAuth.setSession.mockResolvedValueOnce({ data: { user: lee, session: { access_token: 'a-fresh', refresh_token: 'r-fresh', user: lee } }, error: null });
      expect(await server.deleteAccountWithPasscode('582039')).toEqual(tryAgain);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});

describe('staying signed in', () => {
  // supabase-js itself, not the stand-in: what it does with a session it keeps is what keeps a person signed in.
  const actual = jest.requireActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  /** Every file the app is built from, tests aside. */
  const appFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : appFiles(`${dir}/${e.name}`)) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  /** Each call the pattern finds in a file's code (comments aside), named by the top-level function it is made from. */
  function callers(file: string, pattern: RegExp): string[] {
    let within = '(the module itself)';
    const found: string[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const declared = /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=/.exec(line);
      if (declared) within = declared[1] ?? declared[2];
      if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
      for (const match of line.replace(/\/\/.*$/, '').matchAll(pattern)) found.push(match[1] ? `${within} ${match[1]}` : within);
    }
    return found;
  }

  const KEY = 'minemuster-server-session';
  const DAY = 86_400_000;
  const base64url = (text: string) => btoa(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  /** An access token as Supabase Auth makes one. The phone only reads what is in it (whose, and until when); the server checks it. */
  const token = (sub: string, exp: number) => `${[{ alg: 'HS256', typ: 'JWT' }, { sub, exp, role: 'authenticated' }].map((part) => base64url(JSON.stringify(part))).join('.')}.c2lnbmVk`;
  /** The app started again: nothing of it is left in memory, and the phone's storage is as it was. */
  function restartedApp(): typeof import('../server') {
    let app: typeof import('../server') | undefined;
    jest.isolateModules(() => {
      app = require('../server');
    });
    return app!;
  }
  /** Let the app run, in the test's own time, until `done`: supabase-js's retries and its refresh ticker go off as they would. */
  async function runUntil(done: () => boolean, limitMs = 5 * 60_000) {
    for (let ran = 0; !done() && ran < limitMs; ran += 1_000) await jest.advanceTimersByTimeAsync(1_000);
  }
  async function settled<T>(promise: Promise<T>): Promise<T> {
    let over = false;
    promise.then(
      () => (over = true),
      () => (over = true),
    );
    await runUntil(() => over);
    return promise;
  }
  const stored = async () => JSON.parse((await safeStorage.getItem(KEY)) ?? 'null') as { refresh_token?: string; user?: { id?: string } } | null;

  it('keeps the session through a restart, days with no signal and an expired token', async () => {
    const clients: SupabaseClient[] = [];
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let signal = true;
    const asked: string[] = [];
    jest.useFakeTimers({ now: Date.parse('2026-11-20T06:00:00Z') });
    mockCreateClient.mockImplementation((...args: unknown[]) => {
      const made = actual.createClient(...(args as Parameters<typeof actual.createClient>));
      clients.push(made);
      return made;
    });
    // Supabase Auth, as far as the phone can reach it.
    mockFetch.mockImplementation(async (url, init) => {
      const path = url.replace('https://example.supabase.co', '');
      asked.push(`${init.method ?? 'GET'} ${path}`);
      if (!signal) throw new TypeError('Network request failed');
      const now = Math.floor(Date.now() / 1000);
      if (path === '/auth/v1/user') return reply(200, SAM_USER);
      if (path === '/auth/v1/token?grant_type=refresh_token') {
        return reply(200, { access_token: token('u-sam', now + 3600), refresh_token: 'r-2', token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user: SAM_USER });
      }
      return reply(404, { message: 'Not found' });
    });
    await safeStorage.removeItem(KEY);
    try {
      // Day one, with signal: Sam signs in with his passcode, and the session goes into the app's own storage.
      const first = restartedApp();
      const t0 = Math.floor(Date.now() / 1000);
      expect(await first.startCrewSession({ accessToken: token('u-sam', t0 + 3600), refreshToken: 'r-1', expiresAt: t0 + 3600, userId: 'u-sam' })).toEqual({ ok: true, account: SAM });
      const [url, key, options] = mockCreateClient.mock.calls[mockCreateClient.mock.calls.length - 1] as [string, string, { auth: Record<string, unknown> }];
      expect([url, key]).toEqual(['https://example.supabase.co', 'sb_publishable_test']);
      expect(options.auth).toMatchObject({ persistSession: true, autoRefreshToken: true, storageKey: KEY });
      expect(await stored()).toMatchObject({ refresh_token: 'r-1', user: { id: 'u-sam' } });

      // The app is closed, and three days go by with no signal: the access token has long expired.
      await clients[0].auth.stopAutoRefresh();
      signal = false;
      jest.setSystemTime(Date.now() + 3 * DAY);
      const reopened = restartedApp();
      const heard: unknown[] = [];
      const stop = reopened.onAccountChange((account) => heard.push(account));
      await runUntil(() => heard.length > 0);
      // Still Sam, read from the phone: supabase-js could not refresh the token, and kept the session as it was.
      expect(heard).toEqual([SAM]);
      expect(await stored()).toMatchObject({ refresh_token: 'r-1', user: { id: 'u-sam' } });
      // Records wait for signal, and the phone says that, not that anyone is signed out.
      await expect(settled(reopened.companyTransport('c-a').push([change('shift:s1', 'r1')]))).rejects.toMatchObject({ trouble: 'unreachable' });
      // An hour more with the app open and still no signal: supabase-js keeps trying to refresh, and keeps the session.
      await jest.advanceTimersByTimeAsync(60 * 60_000);
      expect(heard).toEqual([SAM]);
      expect(await stored()).toMatchObject({ refresh_token: 'r-1', user: { id: 'u-sam' } });

      // Signal again: the session is refreshed by itself, and Sam is still the one signed in.
      signal = true;
      await runUntil(() => heard.length > 1);
      expect(heard).toEqual([SAM, SAM]);
      expect(await stored()).toMatchObject({ refresh_token: 'r-2', user: { id: 'u-sam' } });
      stop();
      // supabase-js asked for the account once, and for refreshes; never to sign anyone out.
      expect(new Set(asked)).toEqual(new Set(['GET /auth/v1/user', 'POST /auth/v1/token?grant_type=refresh_token']));
      // All it warned of was no signal.
      expect(warned).toHaveBeenCalled();
      for (const [said] of warned.mock.calls) expect((said as { name?: unknown } | null)?.name).toBe('AuthRetryableFetchError');
    } finally {
      for (const made of clients) await made.auth.stopAutoRefresh();
      jest.useRealTimers();
      mockCreateClient.mockImplementation(fakeClient);
      warned.mockRestore();
      await safeStorage.removeItem(KEY);
    }

    // Nothing signs the phone out by itself. The client's sign-out, and taking the session off the
    // phone, are made by server.signOut alone ...
    const serverFile = `${src}/services/server.ts`;
    const clientCalls = callers(serverFile, /\bauth\.(\w+)\(/g);
    expect(clientCalls.filter((call) => call.endsWith(' signOut'))).toEqual(['signOut signOut']);
    expect(callers(serverFile, /(?<!function )\bforgetSession\(/g)).toEqual(['signOut']);
    const rel = (file: string) => file.slice(src.length + 1);
    expect(appFiles(src).filter((file) => /\bauth\.signOut\(/.test(fs.readFileSync(file, 'utf8'))).map(rel)).toEqual(['services/server.ts']);
    // ... which is asked for only when the person disconnects or signs out, and once their sign-in is deleted.
    expect(appFiles(src).flatMap((file) => callers(file, /\b(?:server|link)\??\.signOut\(/g).map((fn) => `${rel(file)} ${fn}`)).sort()).toEqual([
      // Sign out of the server, on Company account.
      'screens/more/CompanyAccountScreen.tsx AccountRow',
      // Disconnect on Company account, and clearing the phone on More.
      'services/connection.ts disconnect',
      // The sign-in is deleted.
      'services/connection.ts forgetDeletedSignIn',
    ]);
  });
});
