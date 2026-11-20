import type { Change } from '../../domain/sync';

// A made-up project: no request leaves the test.
jest.mock('../../config', () => ({ SERVER: { url: 'https://example.supabase.co', key: 'sb_publishable_test' } }));

const mockRpc = jest.fn();
const mockAuth = {
  signInWithPassword: jest.fn(),
  signUp: jest.fn(),
  signOut: jest.fn(),
  getSession: jest.fn(),
  onAuthStateChange: jest.fn(),
  startAutoRefresh: jest.fn(),
  stopAutoRefresh: jest.fn(),
  resend: jest.fn(),
  resetPasswordForEmail: jest.fn(),
};
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
const mockCreateClient = jest.fn((..._args: unknown[]) => ({ rpc: mockRpc, auth: mockAuth, from: mockFrom }));
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../server') as typeof import('../server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { safeStorage } = require('../storage') as typeof import('../storage');

const change = (key: string, rev: string, record: unknown = { id: key }): Change => {
  const [kind, id] = key.split(':');
  return { key, kind: kind as Change['kind'], id, rev, record };
};

/** What supabase-js tells the client's listener, the way it would. */
let authEvent: (event: string, session: unknown) => void = () => undefined;
const unsubscribe = jest.fn();
const AVERY = { id: 'u-avery', email: 'avery@example.com' };
const sessionOf = (user: { id: string; email: string }) => ({ access_token: 'a', refresh_token: 'r', user });
const offline = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };

beforeEach(() => {
  mockRpc.mockReset();
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
    expect(await server.signIn(' Avery@Example.com ', 'haulroad88')).toEqual({ ok: true, account: AVERY });
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
    expect(heard).toEqual([AVERY]);
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
