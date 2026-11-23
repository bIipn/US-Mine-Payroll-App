// "Delete my account" on a phone joined with the person's own sign-in waits only for what a round could
// still send. A record the server will never take as it is (stuck), or records that cannot go because the
// sign-in is off the company's roster, stay on the phone and do not hold the deletion up for good. A
// made-up project and made-up people; no request leaves the test (mocks as in connection.test.ts).
const mockSignOut = jest.fn(async (_options?: unknown) => ({ error: null }));
const mockRpc = jest.fn();
const mockGetSession = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockInvoke = jest.fn();
/** Whether Avery's sign-in is still on the company's roster (its own row, read by a round's standing step). */
let mockOnRoster = true;
const mockFrom = (table: string) => {
  let user: string | undefined;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: string) => ((column === 'user_id' ? (user = value) : null), chain),
    maybeSingle: () => chain,
    abortSignal: () => chain,
    then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve({ data: table === 'roster' && user === 'u-avery' && mockOnRoster ? { first_name: 'Avery', last_name: 'Quill', role: 'supervisor' } : null, error: null }).then(ok, fail),
  };
  return chain;
};
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: mockRpc,
    from: (table: string) => mockFrom(table),
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
    auth: {
      signOut: mockSignOut,
      getSession: mockGetSession,
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      startAutoRefresh: jest.fn(),
      stopAutoRefresh: jest.fn(),
    },
  }),
}));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: () => ({ remove() {} }),
}));

import { deletionPlan } from '../../domain/accountDeletion';

type Loaded = { connection: typeof import('../connection'); sync: typeof import('../sync'); store: typeof import('../../store/useStore') };
function build(): Loaded {
  const saved = { ...process.env };
  for (const key of ['EXPO_PUBLIC_SAMPLE_CREW', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
  Object.assign(process.env, {
    EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
    EXPO_PUBLIC_DEMO: '0',
    EXPO_PUBLIC_ROSTER: 'Quill, Avery | Supervisor | supervisor\nRook, Blake | Loader Operator',
  });
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    loaded = { connection: require('../connection'), sync: require('../sync'), store: require('../../store/useStore') };
  });
  process.env = saved;
  return loaded!;
}

const AVERY = { id: 'u-avery', email: 'avery@example.com' };
const PIT_A = { id: 'c-a', name: 'Test Pit A', role: 'supervisor' as const };
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
/** The server takes every change but one, which it turns down for what is in it (a 22xxx error: 'refused'). */
function fakeServer(bad: string) {
  const pushes: string[][] = [];
  mockRpc.mockImplementation((fn: string, args: { changes?: { key: string; rev: string }[] }) => {
    let answer: unknown = { data: null, error: null };
    if (fn === 'my_companies') answer = { data: [PIT_A], error: null };
    else if (fn === 'read_shared_records') answer = { data: [], error: null };
    else if (fn === 'push_records') {
      const keys = args.changes!.map((c) => c.key);
      pushes.push(keys);
      answer = keys.includes(bad)
        ? { data: null, error: { code: '22023', message: 'The record is not one the server can take.' } }
        : { data: { accepted: args.changes!.map((c) => ({ key: c.key, rev: c.rev })), ignored: [] }, error: null };
    }
    const done = Promise.resolve(answer);
    const call = { then: done.then.bind(done), abortSignal: () => call };
    return call;
  });
  return pushes;
}
const shift = (id: string, at: number) => ({ id, employeeId: 'emp-test', clockIn: { at }, clockOut: { at: at + 600_000 }, lunches: [], breaks: [] });

it('does not keep the deletion blocked for good by a record the server will never take', async () => {
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'a', refresh_token: 'r', user: AVERY } }, error: null });
  const app = build();
  const pushes = fakeServer('shift:sh-bad');
  const { useStore } = app.store;
  useStore.getState().ensureSeeded();
  useStore.setState({ shifts: [shift('sh-1', 1_763_300_000_000), shift('sh-bad', 1_763_310_000_000)] });
  useStore.getState().connectCompany(PIT_A, AVERY);
  const stopSync = app.sync.startSync();
  const stopLink = app.connection.watchConnection();
  try {
    await settle();
    await app.sync.syncNow();
    await settle();
    // The good shift went; the bad one is held back as stuck, and counted as waiting.
    expect(pushes.flat()).toContain('shift:sh-1');
    const status = app.sync.useSyncStatus.getState();
    expect({ waiting: status.waiting, stuck: status.stuck }).toEqual({ waiting: 1, stuck: 1 });

    // What the Delete my account screen shows for it (DeleteAccountScreen passes useSyncStatus straight in).
    const r = useStore.getState().receiving!;
    const plan = deletionPlan({
      now: Date.now(),
      me: { id: 'emp-avery', firstName: 'Avery', lastName: 'Quill', role: 'supervisor', active: true },
      account: { email: 'avery@example.com', passwordHash: 'h' },
      sample: false,
      keepsTime: true,
      company: 'Test Pit A',
      hasRate: false,
      canConnect: true,
      linked: useStore.getState().connectedCompany,
      standing: { role: r.role, name: r.name },
      serverAccount: AVERY,
      otherAccounts: 0,
      othersOnClock: 0,
      caughtUp: r.caughtUpAt != null,
      sync: { online: status.online, waiting: status.waiting, notTaken: status.notTaken, stuck: status.stuck, trouble: status.trouble },
      check: [{ id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: false, successors: [], canClose: false, closeFrom: null, running: 0 }],
      fmtTime: () => '',
      fmtDay: () => '',
    });

    // "Send now", as many times as the person likes, and then the delete itself.
    await app.sync.syncNow();
    await app.sync.syncNow();
    mockSignInWithPassword.mockResolvedValue({ data: { session: { access_token: 'a2', refresh_token: 'r2', user: AVERY }, user: AVERY }, error: null });
    mockInvoke.mockResolvedValue({ data: { deleted: true, closed: [] }, error: null });
    const result = await app.connection.deleteMyServerAccount({ password: 'haulroad88' });

    // Before: the only blocker said the record "is sent before your company sign-in is deleted", and the
    // service answered 'waiting' every time. Now the record stays on the phone, and the deletion goes ahead.
    expect({ blockers: plan.blockers.map((b) => b.kind), result: result.ok ? 'deleted' : result.reason }).toEqual({ blockers: [], result: 'deleted' });
    expect(plan.warnings).toContain('1 record cannot be sent to Test Pit A, so it stays on this phone.');
  } finally {
    stopLink();
    stopSync();
  }
});

it('does not keep it blocked for good once the sign-in is off the roster and nothing can be sent with it', async () => {
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'a', refresh_token: 'r', user: AVERY } }, error: null });
  const app = build();
  fakeServer('none');
  const { useStore } = app.store;
  useStore.getState().ensureSeeded();
  useStore.getState().connectCompany(PIT_A, AVERY);
  const stopSync = app.sync.startSync();
  const stopLink = app.connection.watchConnection();
  try {
    await settle();
    await app.sync.syncNow();
    await settle();
    expect(app.sync.useSyncStatus.getState().waiting).toBe(0);
    // Two punches made with no signal; then the office takes Avery off the roster before the phone sends.
    app.sync.useSyncStatus.setState({ online: false });
    useStore.setState({ shifts: [shift('sh-a', 1_763_300_000_000), shift('sh-b', 1_763_310_000_000)] });
    mockOnRoster = false;
    mockRpc.mockImplementation((fn: string) => {
      const answer = fn === 'push_records' || fn === 'read_shared_records' ? { data: null, error: { code: '42501', message: 'permission denied' } } : { data: [], error: null };
      const done = Promise.resolve(answer);
      const call = { then: done.then.bind(done), abortSignal: () => call };
      return call;
    });
    app.sync.useSyncStatus.setState({ online: true });
    await app.sync.syncNow();
    await settle();
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ trouble: 'not_member', waiting: 2 });
    mockSignInWithPassword.mockResolvedValue({ data: { session: { access_token: 'a2', refresh_token: 'r2', user: AVERY }, user: AVERY }, error: null });
    mockInvoke.mockResolvedValue({ data: { deleted: true, closed: [] }, error: null });
    const result = await app.connection.deleteMyServerAccount({ password: 'haulroad88' });
    // Before: 'waiting' for good, since no round will ever send them.
    expect(result.ok ? 'deleted' : result.reason).toBe('deleted');
  } finally {
    stopLink();
    stopSync();
    mockOnRoster = true;
  }
});
