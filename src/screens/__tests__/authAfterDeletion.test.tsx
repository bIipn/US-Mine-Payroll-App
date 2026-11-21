// After a deletion that does not clear the phone (another account is on it), the sign-in screen does not
// hand the deleted sign-in's name to the next account made here. The phone is no longer joined, so
// nothing on it goes by who that sign-in was to the company: the name fields are empty and can be typed
// in, and nobody's account is made on the deleted person's record. Everyone here is made up.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, ProviderMark: () => null }));
jest.mock('../../components/WebPageLinks', () => ({ WebPageLinks: () => null }));
jest.mock('../../services/connection', () => ({ CAN_CONNECT: true, server: null }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-navigation/native', () => ({ ...jest.requireActual('@react-navigation/native'), useNavigation: () => ({ navigate: () => undefined }) }));

const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SAMPLE_CREW', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, {
  EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
  EXPO_PUBLIC_DEMO: '0',
  EXPO_PUBLIC_ROSTER: 'Fry, Dana | Loader Operator\nPark, Lee | Crusher\nOrtiz, Pat | Driller',
});

const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: { props: Record<string, unknown> }) => boolean): { props: Record<string, unknown> }[] } } };
const { AuthScreen } = require('../auth/AuthScreen') as typeof import('../auth/AuthScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('does not hand the deleted person’s name to the next account made on the phone', async () => {
  const g = () => useStore.getState();
  g().ensureSeeded();
  // Lee made an account here before the phone was joined.
  expect(g().signUp({ firstName: 'Lee', lastName: 'Park', email: 'lee@example.com', password: 'crusher77' })).toMatchObject({ ok: true });
  g().signOut();
  // The phone joins Test Pit A with Dana's crew sign-in and has the company's records.
  useStore.setState({ connectedCompany: { id: 'c-test-a', name: 'Test Pit A', role: 'employee', userId: 'u-dana', email: 'dana@example.com' }, syncedWith: 'c-test-a' });
  const r = g().ensureReceiving()!;
  g().applyStanding({ company: 'c-test-a', account: 'u-dana', epoch: r.epoch }, { role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' } });
  useStore.setState({ receiving: { ...g().receiving!, caughtUpAt: Date.now() } });
  expect(g().signUp({ firstName: 'Dana', lastName: 'Fry', email: 'dana@example.com', password: 'haulroad88' })).toMatchObject({ ok: true });
  const dana = g().session!.employeeId;

  // Delete my account: the server deleted Dana's sign-in, connection.ts disconnected the phone, then the store.
  g().disconnectCompany();
  expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
  expect(g().receiving).toMatchObject({ role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' } });

  // The sign-in screen, for the next person.
  const root = createRoot();
  await act(async () => root.render(React.createElement(AuthScreen)));
  const first = root.container.queryAll((n) => n.props.testID === 'first-name' && 'editable' in n.props)[0];
  const last = root.container.queryAll((n) => n.props.testID === 'last-name' && 'editable' in n.props)[0];
  // Pat, who has no account here, makes one: the name fields are the only thing Pat cannot type in.
  const made = g().signUp({ firstName: String(first?.props.value ?? ''), lastName: String(last?.props.value ?? ''), email: 'pat@example.com', password: 'pitcrew99' });
  const signedInAs = g().employees.find((e) => e.id === g().session?.employeeId);
  await act(async () => root.unmount());

  // Before: the form opened on Create account with First name "Dana", Last name "Fry", both locked, and
  // Pat's new account was made on Dana's record. Now it opens on Sign in: no name is put in or locked.
  expect({
    first: first ? { value: first.props.value, editable: first.props.editable } : 'not shown',
    last: last ? { value: last.props.value, editable: last.props.editable } : 'not shown',
    madeAsDana: made.ok && g().session?.employeeId === dana,
    signedInAs: signedInAs ? `${signedInAs.firstName} ${signedInAs.lastName}` : null,
  }).toEqual({ first: 'not shown', last: 'not shown', madeAsDana: false, signedInAs: null });
});
