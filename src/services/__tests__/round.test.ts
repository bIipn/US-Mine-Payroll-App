// A round of the phone's sync with its company, against a fake company server: what was made here
// first, then who the phone's sign-in is, then the company's records page by page, then the phone's
// changes of the four kinds made from what it just read. Made-up company, people, units and sheets;
// no request leaves the test.
import type { PushAnswer, ReceivedRow, Standing } from '../../domain/sync';

jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: () => ({ remove() {} }),
}));

type Loaded = { sync: typeof import('../sync'); store: typeof import('../../store/useStore'); domain: typeof import('../../domain/sync') };

/** A build that connects: not a preview, no sample crew, a server named. */
function build(): Loaded {
  const saved = process.env;
  process.env = {
    ...saved,
    EXPO_PUBLIC_DEMO: '0',
    EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
    EXPO_PUBLIC_ROSTER: 'Quill, Avery | Supervisor | supervisor\nRook, Blake | Loader Operator',
  };
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    loaded = { sync: require('../sync'), store: require('../../store/useStore'), domain: require('../../domain/sync') };
  });
  process.env = saved;
  return loaded!;
}

const AVERY = { firstName: 'Avery', lastName: 'Quill' };
const COMPANY = { id: 'c-a', name: 'Test Pit A', role: 'supervisor' as const, userId: 'u-avery', email: 'avery@example.test' };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const took = (changes: readonly { key: string; rev: string }[]): PushAnswer => ({ took: changes.map(({ key, rev }) => ({ key, rev })), stale: [], floored: [], held: [] });

/** The company's server: what it holds, and every call made to it, in order. */
function company(app: Loaded, options: { standing?: Standing | null; settings?: boolean } = {}) {
  const calls: string[] = [];
  // The company's settings, the same as the phone's: nothing about them to send.
  const rows = options.settings === false ? [] : [rowOf(app, 'settings', app.domain.sharedSettings(app.store.useStore.getState().settings))];
  let answer: (changes: readonly { key: string; kind: string; rev: string }[]) => PushAnswer = took;
  let pull: ((after: number, max: number) => Promise<ReceivedRow[]>) | null = null;
  const transport = {
    company: COMPANY.id,
    async push(changes: readonly { key: string; kind: string; rev: string }[]) {
      calls.push(`push ${[...new Set(changes.map((c) => c.kind))].join(',')}`);
      return answer(changes);
    },
    async pull(after: number, max: number) {
      calls.push(`pull ${after}`);
      return pull ? pull(after, max) : rows.filter((r) => r.seq > after).slice(0, max);
    },
    async standing() {
      calls.push('standing');
      return options.standing === undefined ? { role: 'supervisor' as const, name: AVERY } : options.standing;
    },
    async companyRow() {
      calls.push('companyRow');
      return { name: 'Test Pit A', state: 'NV', pay: null };
    },
  };
  return {
    calls,
    rows,
    transport,
    answerWith: (next: typeof answer) => (answer = next),
    pullWith: (next: typeof pull) => (pull = next),
    connect: () => app.sync.setSyncTransport(transport),
  };
}

let seq = 0;
const rowOf = (app: Loaded, kind: ReceivedRow['kind'], data: { id?: string } & object): ReceivedRow => {
  seq += 1;
  return { kind, id: kind === 'settings' ? 'company' : data.id!, rev: app.domain.revOf(data), seq, deleted: false, data };
};
const sheet = (extra = {}) => ({ id: 'test-bench', title: 'Test bench', rows: [{ id: 'r1', label: 'Walkways' }], active: true, ...extra });
const shift = { id: 'sh-1', employeeId: 'emp-test', clockIn: { at: 1_763_300_000_000 }, clockOut: { at: 1_763_330_000_000 }, lunches: [], breaks: [] };

/** A phone joined to Test Pit A with Avery's supervisor sign-in, a shift of its own to send. */
function phone() {
  const app = build();
  const { useStore } = app.store;
  useStore.getState().ensureSeeded();
  useStore.getState().connectCompany(COMPANY, { id: COMPANY.userId, email: COMPANY.email });
  useStore.setState({ shifts: [shift], settings: { ...useStore.getState().settings, company: { name: 'Test Pit A', state: 'NV', pay: null } } });
  return { app, useStore, stop: app.sync.startSync() };
}

beforeEach(() => {
  seq = 0;
});

describe('a round', () => {
  it('sends what was made here, asks who the sign-in is, reads the company’s records, then sends the rest', async () => {
    const { app, useStore, stop } = phone();
    const server = company(app);
    server.rows.push(rowOf(app, 'areaSheet', sheet()));
    server.connect();
    await settle();
    expect(server.calls).toEqual(['push shift', 'standing', 'pull 0', 'pull 2']);
    expect(useStore.getState().areaSheets).toEqual([sheet()]);
    expect(useStore.getState().receiving).toMatchObject({ role: 'supervisor', name: AVERY, cursor: 2 });

    // A supervisor's change to the sheet goes after the next read, made from the version read.
    server.calls.length = 0;
    useStore.setState({ areaSheets: [sheet({ title: 'Test bench north' })] });
    await app.sync.syncNow();
    expect(server.calls).toEqual(['standing', 'pull 2', 'push areaSheet']);
    expect(useStore.getState().synced['areaSheet:test-bench']).toBe(app.domain.revOf(sheet({ title: 'Test bench north' })));
    stop();
  });

  it('reads the standing even when the send was turned away, and stops there for a sign-in off the roster', async () => {
    const { app, useStore, stop } = phone();
    const server = company(app, { standing: null });
    server.answerWith(() => {
      throw app.domain.sendError('not_member', 'This account is not on the company’s roster any more.');
    });
    server.connect();
    await settle();
    expect(server.calls).toEqual(['push shift', 'standing']);
    expect(useStore.getState().receiving?.role).toBe('none');
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ failed: true, trouble: 'not_member' });
    stop();
  });

  it('stops when MineMuster has stopped for the company, and says so', async () => {
    const { app, stop } = phone();
    const server = company(app);
    server.pullWith(async () => {
      throw app.domain.sendError('closed', 'MineMuster is not active for this company.');
    });
    server.connect();
    await settle();
    expect(server.calls).toEqual(['push shift', 'standing', 'pull 0']);
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ failed: true, trouble: 'closed' });
    stop();
  });

  it('reads and sends again when the server holds a newer version than the change was made from, at most twice', async () => {
    const { app, useStore, stop } = phone();
    const server = company(app);
    server.rows.push(rowOf(app, 'areaSheet', sheet()));
    server.connect();
    await settle();
    server.calls.length = 0;
    server.answerWith((changes) => ({ took: [], stale: changes.map(({ key, rev }) => ({ key, rev })), floored: [], held: [] }));
    useStore.setState({ areaSheets: [sheet({ title: 'Test bench north' })] });
    await app.sync.syncNow();
    expect(server.calls).toEqual(['standing', 'pull 2', 'push areaSheet', 'pull 2', 'push areaSheet', 'pull 2', 'push areaSheet']);
    stop();
  });

  it('holds what the company would not take from this sign-in, counts it apart, and does not send it again', async () => {
    const { app, useStore, stop } = phone();
    const server = company(app);
    server.answerWith((changes) => ({ took: [], stale: [], floored: [], held: changes.map(({ key, rev }) => ({ key, rev, reason: 'supervisor_only' as const })) }));
    server.connect();
    await settle();
    // The company's first answer about the sign-in (a supervisor's, from not knowing) lets what was held go once more.
    expect(useStore.getState().receiving?.held).toEqual({});
    await app.sync.syncNow();
    expect(useStore.getState().receiving?.held).toEqual({ 'shift:sh-1': { rev: app.domain.revOf(shift), reason: 'supervisor_only' } });
    expect(useStore.getState().synced['shift:sh-1']).toBeUndefined();
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ waiting: 0, notTaken: 1 });
    server.calls.length = 0;
    await app.sync.syncNow();
    expect(server.calls).toEqual(['standing', 'pull 1']);
    stop();
  });

  it('applies nothing read after the phone is disconnected', async () => {
    const { app, useStore, stop } = phone();
    const server = company(app);
    let answer: (rows: ReceivedRow[]) => void = () => undefined;
    server.pullWith(() => new Promise((resolve) => (answer = resolve)));
    server.connect();
    await settle();
    expect(server.calls).toEqual(['push shift', 'standing', 'pull 0']);
    app.sync.setSyncTransport(null);
    answer([rowOf(app, 'areaSheet', sheet())]);
    await settle();
    expect(useStore.getState().areaSheets).toEqual([]);
    expect(useStore.getState().receiving?.cursor).toBe(0);
    stop();
  });

  it('starts a company that never sent its settings from its own row, once', async () => {
    const { app, useStore, stop } = phone();
    useStore.setState({ settings: { ...useStore.getState().settings, company: { name: '', state: '', pay: null } } });
    const server = company(app, { settings: false });
    server.connect();
    await settle();
    expect(server.calls).toEqual(['push shift', 'standing', 'pull 0', 'companyRow', 'push settings']);
    expect(useStore.getState().settings.company).toMatchObject({ name: 'Test Pit A', state: 'NV' });
    server.calls.length = 0;
    await app.sync.syncNow();
    expect(server.calls).not.toContain('companyRow');
    stop();
  });
});

describe('the company’s records, a page at a time', () => {
  afterEach(() => jest.useRealTimers());

  it('halves the next page after one that had no answer in time', async () => {
    jest.useFakeTimers();
    const { app, useStore, stop } = phone();
    const server = company(app);
    server.pullWith(() => new Promise(() => undefined));
    server.connect();
    await jest.advanceTimersByTimeAsync(31_000);
    expect(useStore.getState().receiving?.pageSize).toBe(100);
    expect(app.sync.useSyncStatus.getState()).toMatchObject({ failed: true, trouble: 'unreachable' });
    stop();
  });

  it('reads again every five minutes while the app is open', async () => {
    jest.useFakeTimers();
    const { app, stop } = phone();
    const server = company(app);
    server.connect();
    await jest.advanceTimersByTimeAsync(10);
    const before = server.calls.filter((c) => c === 'standing').length;
    await jest.advanceTimersByTimeAsync(app.sync.RECEIVE_EVERY_MS + 10);
    expect(server.calls.filter((c) => c === 'standing').length).toBe(before + 1);
    stop();
    await jest.advanceTimersByTimeAsync(app.sync.RECEIVE_EVERY_MS + 10);
    expect(server.calls.filter((c) => c === 'standing').length).toBe(before + 1);
  });
});
