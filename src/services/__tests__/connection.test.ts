// Which builds connect to a company server, and how the phone starts and stops sending.
// A made-up project, made-up companies and made-up people: no request leaves the test.

const mockSignOut = jest.fn(async (_options?: unknown) => ({ error: null }));
const mockRpc = jest.fn();
const mockGetSession = jest.fn();
let mockAuthEvent: (event: string, session: unknown) => void = () => undefined;
/** Each sign-in's own row of the company's roster, by account; none is not on the roster. */
const mockRosterRows: Record<string, { first_name: string; last_name: string; role: string }> = {
  'u-avery': { first_name: 'Avery', last_name: 'Quill', role: 'supervisor' },
  'u-blake': { first_name: 'Blake', last_name: 'Rook', role: 'employee' },
};
/** A read of one table, the way supabase-js chains it: the roster answers the account's own row. */
const mockFrom = (table: string) => {
  let user: string | undefined;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: string) => ((column === 'user_id' ? (user = value) : null), chain),
    maybeSingle: () => chain,
    abortSignal: () => chain,
    then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve({ data: table === 'roster' && user ? (mockRosterRows[user] ?? null) : null, error: null }).then(ok, fail),
  };
  return chain;
};
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: mockRpc,
    from: (table: string) => mockFrom(table),
    auth: {
      signOut: mockSignOut,
      getSession: mockGetSession,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        mockAuthEvent = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      startAutoRefresh: jest.fn(),
      stopAutoRefresh: jest.fn(),
    },
  }),
}));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: () => ({ remove() {} }),
}));

type Loaded = {
  config: typeof import('../../config');
  connection: typeof import('../connection');
  sync: typeof import('../sync');
  store: typeof import('../../store/useStore');
};

const SERVER_ENV = { EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test' };
const ROSTER = 'Quill, Avery | Supervisor | supervisor\nRook, Blake | Loader Operator';
/** A build that connects: not a preview, its own roster, a server. */
const CONNECTS = { ...SERVER_ENV, EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: ROSTER };

/** The app as a build with these settings starts it. */
function build(env: Record<string, string>): Loaded {
  const saved = { ...process.env };
  for (const key of [
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_KEY',
    'EXPO_PUBLIC_SAMPLE_CREW',
    'EXPO_PUBLIC_ROSTER',
    'EXPO_PUBLIC_ROSTER_OWNER',
    'EXPO_PUBLIC_DEMO',
    'EXPO_PUBLIC_AREA_SHEETS',
    'EXPO_PUBLIC_COMPANY',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    loaded = {
      config: require('../../config'),
      connection: require('../connection'),
      sync: require('../sync'),
      store: require('../../store/useStore'),
    };
  });
  process.env = saved;
  return loaded!;
}

const AVERY = { id: 'u-avery', email: 'avery@example.com' };
const BLAKE = { id: 'u-blake', email: 'blake@example.com' };
const PIT_A = { id: 'c-a', name: 'Test Pit A', role: 'supervisor' as const };
const PIT_B = { id: 'c-b', name: 'Test Pit B', role: 'supervisor' as const };
const sessionOf = (user: { id: string; email: string }) => ({ access_token: 'a', refresh_token: 'r', user });
const signedInAs = (user: { id: string; email: string } | null) =>
  mockGetSession.mockResolvedValue({ data: { session: user ? sessionOf(user) : null }, error: null });
/**
 * The company has answered who this phone's company sign-in is: Avery, a supervisor. Accounts on a
 * connected phone, and a supervisor's powers there, go by that answer.
 */
function answered(useStore: Loaded['store']['useStore']) {
  const state = useStore.getState();
  const receiving = state.ensureReceiving()!;
  state.applyStanding({ company: PIT_A.id, account: AVERY.id, epoch: receiving.epoch }, { role: 'supervisor', name: { firstName: 'Avery', lastName: 'Quill' } });
}
/** A boundary on the made-up pit, so its crew can clock in: with none set, nobody can. */
function setSite(useStore: Loaded['store']['useStore']) {
  useStore.setState((state) => ({ settings: { ...state.settings, site: { name: 'Test Pit A', center: { lat: 1, lng: 1 }, radiusM: 1000 } } }));
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

type Push = { companyId: string; keys: string[]; signal?: AbortSignal; answer: () => void };

/** The server: my_companies answers with `companies`, and push_records answers at once, or only when the test lets it. */
function fakeServer({ hold = false, companies = [PIT_A] as { id: string; name: string; role: string }[] } = {}) {
  const pushes: Push[] = [];
  mockRpc.mockImplementation((fn: string, args: { company_id: string; changes: { key: string; rev: string }[] }) => {
    let resolve: (value: unknown) => void = () => undefined;
    const answer = new Promise((r) => (resolve = r));
    const call = { then: answer.then.bind(answer), abortSignal: (signal: AbortSignal) => ((push && (push.signal = signal)), call) };
    let push: Push | null = null;
    if (fn === 'my_companies') resolve({ data: companies, error: null });
    else if (fn === 'read_shared_records') resolve({ data: [], error: null });
    else if (fn === 'push_records') {
      push = {
        companyId: args.company_id,
        keys: args.changes.map((c) => c.key),
        answer: () => resolve({ data: { accepted: args.changes.map((c) => ({ key: c.key, rev: c.rev })), ignored: [] }, error: null }),
      };
      pushes.push(push);
      if (!hold) push.answer();
    } else resolve({ data: null, error: null });
    return call;
  });
  return pushes;
}

/**
 * Records this phone made: shifts of a made-up person. A connected phone sends what it makes, and
 * never a person (people change on the dashboard).
 */
const shiftsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `sh-${i}`, employeeId: 'emp-test', clockIn: { at: 1_763_300_000_000 + i * 1000 }, clockOut: { at: 1_763_300_600_000 + i * 1000 }, lunches: [], breaks: [] }));

const warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeEach(() => {
  mockSignOut.mockClear();
  mockRpc.mockReset();
  warned.mockClear();
  signedInAs(AVERY);
});

describe('which builds connect', () => {
  it('has no server, no account screen and no transport in a build that names no server', () => {
    const app = build({ EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: ROSTER });
    expect(app.connection.server).toBeNull();
    expect(app.connection.CAN_CONNECT).toBe(false);
    const stop = app.connection.watchConnection();
    app.store.useStore.getState().connectCompany(PIT_A, AVERY);
    expect(app.sync.useSyncStatus.getState().server).toBe(false);
    stop();
  });

  it('connects to nothing in a build that holds the sample crew, even with a server named', () => {
    const app = build({ ...SERVER_ENV, EXPO_PUBLIC_SAMPLE_CREW: '1' });
    expect(app.store.HOLDS_SAMPLES).toBe(true);
    expect(app.connection.server).toBeNull();
    expect(app.connection.CAN_CONNECT).toBe(false);
  });

  it('connects to nothing in a preview, though it names a server and a roster', async () => {
    // A build like the one .env.local makes, plus a server: EXPO_PUBLIC_DEMO left unset.
    const app = build({ ...SERVER_ENV, EXPO_PUBLIC_ROSTER: ROSTER, EXPO_PUBLIC_ROSTER_OWNER: 'Avery Quill' });
    expect(app.config.DEMO_MODE).toBe(true);
    expect(app.config.SAMPLE_CREW).toBe(false);
    expect(app.config.SERVER).toBeNull();
    // Whoever makes the build is told why it sends nothing.
    expect(warned).toHaveBeenCalledWith(expect.stringMatching(/EXPO_PUBLIC_DEMO=0/));
    expect(app.connection.CAN_CONNECT).toBe(false);
    const pushes = fakeServer();
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    setSite(useStore);
    // What the preview controls make up: opened as the owner with no account, "at the mine", the clock-in moved back.
    expect(useStore.getState().openAsOwner()).toEqual({ ok: true });
    const fake = { lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'demo' as const };
    expect(useStore.getState().clockIn(fake).ok).toBe(true);
    useStore.getState().demoRewindShift(60);
    const stopSync = app.sync.startSync();
    useStore.getState().connectCompany(PIT_A, AVERY);
    const stopLink = app.connection.watchConnection();
    app.sync.setSyncTransport({ company: 'c-a', push: async () => { throw new Error('never called'); } });
    await settle();
    expect(pushes).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(app.sync.useSyncStatus.getState().server).toBe(false);
    stopLink();
    stopSync();
  });

  it('connects to nothing in a build that starts with the sample company, EXPO_PUBLIC_DEMO=0 or not', () => {
    // No roster named, now that it lives on the server: the build starts with the sample company and site.
    const app = build({ ...SERVER_ENV, EXPO_PUBLIC_DEMO: '0' });
    expect(app.config.SAMPLE_CREW).toBe(true);
    expect(app.connection.CAN_CONNECT).toBe(false);
    // Turning the samples off makes it a build that connects, with nothing made up in it.
    const own = build({ ...SERVER_ENV, EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });
    expect(own.connection.CAN_CONNECT).toBe(true);
    expect(own.config.STARTING_COMPANY.name).toBe('');
    expect(own.config.STARTING_SITE).toBeNull();
  });

  it('needs both settings', () => {
    expect(build({ EXPO_PUBLIC_SUPABASE_URL: SERVER_ENV.EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: ROSTER }).connection.CAN_CONNECT).toBe(false);
    expect(build({ EXPO_PUBLIC_SUPABASE_KEY: SERVER_ENV.EXPO_PUBLIC_SUPABASE_KEY, EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_ROSTER: ROSTER }).connection.CAN_CONNECT).toBe(false);
    expect(build(CONNECTS).connection.CAN_CONNECT).toBe(true);
  });
});

describe('a build that connects', () => {
  it('has none of the preview controls, and no sign-in by a typed name alone', () => {
    const app = build(CONNECTS);
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    setSite(useStore);
    expect(useStore.getState().openAsOwner({ firstName: 'Avery', lastName: 'Quill' })).toMatchObject({ ok: false });
    expect(useStore.getState().signInWithProvider('google', 'Blake', 'Rook')).toMatchObject({ ok: false, error: 'Sign in with your email and password.' });
    expect(useStore.getState().signInWithProvider('apple', 'Avery', 'Quill')).toMatchObject({ ok: false });
    expect(useStore.getState().session).toBeNull();
    // A crew member signs in with a password, clocks in, and cannot move the clock-in by themselves.
    expect(useStore.getState().signUp({ firstName: 'Blake', lastName: 'Rook', email: 'blake@example.com', password: 'haulroad88' })).toEqual({ ok: true });
    const geo = { lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'gps' as const };
    const clocked = useStore.getState().clockIn(geo);
    if (!clocked.ok) throw new Error(clocked.error);
    expect(useStore.getState().demoRewindShift(60)).toBeUndefined();
    expect(useStore.getState().editShiftTimes(clocked.shift.id, { clockIn: clocked.shift.clockIn.at - 2 * 3_600_000 }, 'forgot to clock in')).toMatchObject({
      ok: false,
      error: 'Only a supervisor can correct punch times.',
    });
    expect(useStore.getState().shifts[0].clockIn.at).toBe(clocked.shift.clockIn.at);
    // Simulated GPS cannot be turned on.
    useStore.getState().setDemoLocation('at_mine');
    expect(useStore.getState().settings.demoLocation).toBe('gps');
  });

  it('sends to the company the phone connects to, from start-up on, and stops when it is disconnected', async () => {
    const app = build(CONNECTS);
    const pushes = fakeServer();
    const status = () => app.sync.useSyncStatus.getState();
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    useStore.setState({ shifts: shiftsOf(2) });

    // Connected before the app was closed: it sends again as soon as it starts.
    useStore.getState().connectCompany(PIT_A, AVERY);
    const stopSync = app.sync.startSync();
    const stop = app.connection.watchConnection();
    await settle();
    expect(status().server).toBe(true);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((p) => p.companyId === 'c-a')).toBe(true);
    expect(status().waiting).toBe(0);

    await app.connection.disconnect();
    expect(useStore.getState().connectedCompany).toBeNull();
    expect(status().server).toBe(false);
    // Signed out of this phone only.
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });

    // Connected again, then the device is cleared by a supervisor: it forgets the company and stops sending.
    signedInAs(AVERY);
    mockAuthEvent('SIGNED_IN', sessionOf(AVERY));
    useStore.getState().connectCompany(PIT_A, AVERY);
    await settle();
    expect(status().server).toBe(true);
    expect(useStore.getState().clearDevice()).toMatchObject({ ok: false });
    answered(useStore);
    // Avery's own account on the phone joined with Avery's sign-in, its password checked by the server.
    useStore.getState().signUp({ firstName: 'Avery', lastName: 'Quill', email: 'avery@example.com', password: 'haulroad88', companyPasswordChecked: true });
    expect(useStore.getState().clearDevice()).toEqual({ ok: true });
    expect(useStore.getState().connectedCompany).toBeNull();
    expect(status().server).toBe(false);
    // A cleared device that keeps real records starts as a fresh install does: the build's own people and nothing made up.
    expect(useStore.getState().equipment).toEqual([]);
    expect(useStore.getState().employees.map((e) => e.lastName).sort()).toEqual(['Quill', 'Rook']);

    useStore.getState().connectCompany(PIT_A, AVERY);
    stop();
    stopSync();
    expect(status().server).toBe(false);
  });

  it('counts a new record as waiting the moment it is signed, with no signal or before the send', async () => {
    const app = build(CONNECTS);
    fakeServer();
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    setSite(useStore);
    useStore.getState().connectCompany(PIT_A, AVERY);
    const stopSync = app.sync.startSync();
    const stop = app.connection.watchConnection();
    await settle();
    expect(app.sync.useSyncStatus.getState().waiting).toBe(0);
    answered(useStore);
    useStore.getState().signUp({ firstName: 'Blake', lastName: 'Rook', email: 'blake@example.com', password: 'haulroad88' });
    useStore.getState().clockIn({ lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'gps' });
    // Straight away, not after the few seconds the send waits for.
    expect(app.sync.useSyncStatus.getState().waiting).toBe(1);
    stop();
    stopSync();
  });

  it('stops sending when the account is signed out, says so, and sends again once it signs back in', async () => {
    const app = build(CONNECTS);
    const pushes = fakeServer();
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    setSite(useStore);
    useStore.getState().connectCompany(PIT_A, AVERY);
    const stopSync = app.sync.startSync();
    const stop = app.connection.watchConnection();
    await settle();
    const before = pushes.length;

    // The session is turned down elsewhere, or someone signs out: supabase-js says nobody is signed in.
    signedInAs(null);
    mockAuthEvent('SIGNED_OUT', null);
    await settle();
    expect(app.connection.useServerAccount.getState().account).toBeNull();
    answered(useStore);
    useStore.getState().signUp({ firstName: 'Blake', lastName: 'Rook', email: 'blake@example.com', password: 'haulroad88' });
    useStore.getState().clockIn({ lat: 1, lng: 1, accuracyM: 6, distanceM: 10, inside: true, source: 'gps' });
    await new Promise((r) => setTimeout(r, 3_200));
    const status = app.sync.useSyncStatus.getState();
    expect(status).toMatchObject({ server: true, trouble: 'signed_out', waiting: 1 });
    expect(pushes.length).toBe(before);
    // Nothing goes under the publishable key alone.
    expect(mockRpc.mock.calls.filter(([fn]) => fn === 'push_records')).toHaveLength(before);

    signedInAs(AVERY);
    mockAuthEvent('SIGNED_IN', sessionOf(AVERY));
    await settle();
    expect(pushes.length).toBe(before + 1);
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ trouble: null, waiting: 0 });
    stop();
    stopSync();
  }, 10_000);

  it('sends nothing as another account until the server says it is on the company’s roster', async () => {
    const app = build(CONNECTS);
    const pushes = fakeServer({ companies: [] });
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    useStore.getState().connectCompany(PIT_A, AVERY);
    // Someone else signs in on this phone.
    signedInAs(BLAKE);
    const stopSync = app.sync.startSync();
    const stop = app.connection.watchConnection();
    await settle();
    expect(app.connection.useServerAccount.getState()).toMatchObject({ account: BLAKE, notOnLinked: true });
    expect(pushes).toHaveLength(0);
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ server: true, trouble: 'not_member' });
    // The company and the role shown are still the ones the phone joined with: nothing is taken from this account.
    expect(useStore.getState().connectedCompany).toMatchObject({ userId: AVERY.id, role: 'supervisor' });
    stop();
    stopSync();

    // An account that is on the roster, as crew: the phone sends as it, with its own role.
    const app2 = build(CONNECTS);
    const pushes2 = fakeServer({ companies: [{ ...PIT_A, role: 'employee' }] });
    app2.store.useStore.getState().ensureSeeded();
    app2.store.useStore.setState({ shifts: shiftsOf(1) });
    app2.store.useStore.getState().connectCompany(PIT_A, AVERY);
    const stopSync2 = app2.sync.startSync();
    const stop2 = app2.connection.watchConnection();
    await settle();
    expect(app2.store.useStore.getState().connectedCompany).toMatchObject({ userId: BLAKE.id, email: BLAKE.email, role: 'employee' });
    expect(pushes2.length).toBeGreaterThan(0);
    stop2();
    stopSync2();
  });
});

describe('disconnecting while records are on their way', () => {
  const start = (n: number) => {
    const app = build(CONNECTS);
    const pushes = fakeServer({ hold: true });
    const { useStore } = app.store;
    useStore.getState().ensureSeeded();
    useStore.setState({ shifts: shiftsOf(n) });
    const stopSync = app.sync.startSync();
    useStore.getState().connectCompany(PIT_A, AVERY);
    const stopLink = app.connection.watchConnection();
    return { app, pushes, useStore, stop: () => (stopLink(), stopSync()) };
  };

  it('sends nothing more to the old company, and aborts the call under way', async () => {
    const { app, pushes, useStore, stop } = start(250);
    await settle();
    expect(pushes).toHaveLength(1);
    const going = app.connection.disconnect();
    await settle();
    expect(pushes[0].signal?.aborted).toBe(true);
    pushes[0].answer();
    await going;
    await settle();
    expect(pushes).toHaveLength(1);
    // The answer that came back late is not noted: the phone does not know what that company kept.
    expect(useStore.getState().synced).toEqual({});
    stop();
  });

  it('never notes what the old company took as being on the new one', async () => {
    const { app, pushes, useStore, stop } = start(150);
    await settle();
    expect(pushes[0].companyId).toBe('c-a');
    const aKeys = pushes[0].keys;
    // Disconnect from A, then connect to B before A's first call answers.
    await app.connection.disconnect();
    signedInAs(AVERY);
    mockAuthEvent('SIGNED_IN', sessionOf(AVERY));
    expect(useStore.getState().connectCompany(PIT_B, AVERY)).toEqual({ ok: true });
    pushes[0].answer();
    await settle();
    expect(useStore.getState().syncedWith).toBe('c-b');
    expect(aKeys.some((k) => k in useStore.getState().synced)).toBe(false);
    // Everything goes to B.
    for (let i = 0; i < 10; i++) {
      pushes.filter((p) => !(p as { done?: boolean }).done).forEach((p) => ((p as { done?: boolean }).done = true, p.answer()));
      await settle();
    }
    const toB = new Set(pushes.filter((p) => p.companyId === 'c-b').flatMap((p) => p.keys));
    expect(aKeys.every((k) => toB.has(k))).toBe(true);
    expect(pushes.filter((p) => p.companyId === 'c-a')).toHaveLength(1);
    expect(app.sync.useSyncStatus.getState().waiting).toBe(0);
    stop();
  });
});
