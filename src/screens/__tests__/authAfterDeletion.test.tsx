// After a deletion that does not clear the phone (another account is on it), the next person to sign in
// on the phone is not handed the deleted sign-in's name. In a build that connects, the first screen is the
// company sign-in (AuthScreen shows only in builds with no server): nothing on it is filled in from the
// phone, and the account that opens is the one the new person's own sign-in is for, never the deleted
// person's. The phone is no longer joined, so nothing on it goes by who that sign-in was to the company.
// The company server's calls are stand-ins, so no request leaves the test. Everyone here is made up.
import type { CrewAnswer, ServerCompany } from '../../domain/serverAnswers';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../components/WebPageLinks', () => ({ WebPageLinks: () => null }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The company server, as connection.ts hands it to the screen: who is signed in to it, and each call a stub.
jest.mock('../../services/connection', () => {
  const { create } = require('zustand');
  const useServerAccount = create(() => ({ known: true, account: null, notOnLinked: false, checking: false, unchecked: false, joinCode: null, signingOut: false }));
  return {
    CAN_CONNECT: true,
    server: { crewAuth: jest.fn(), startCrewSession: jest.fn(), signOutOtherSessions: jest.fn(), myCompanies: jest.fn(), myJoinRequests: jest.fn() },
    useServerAccount,
    checkAccount: jest.fn(),
    signOutOfPhone: jest.fn(),
  };
});

// A store build that names its roster: it connects, with no sample crew in it.
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

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[] } } };
const { CompanySignInScreen } = require('../auth/CompanySignInScreen') as typeof import('../auth/CompanySignInScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const connection = require('../../services/connection') as { server: Record<string, jest.Mock>; useServerAccount: typeof import('../../services/connection').useServerAccount };
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIT: ServerCompany = { id: 'c-test-a', name: 'Test Pit A', role: 'employee', state: 'NV' };
const PATS_SIGN_IN = { id: 'u-pat', email: '', kind: 'passcode' as const };

it('does not hand the deleted person’s name to the next person who signs in on the phone', async () => {
  const g = () => useStore.getState();
  g().ensureSeeded();
  // Lee made an account here before the phone was joined.
  expect(g().signUp({ firstName: 'Lee', lastName: 'Park', email: 'lee@example.com', password: 'crusher77' })).toMatchObject({ ok: true });
  g().signOut();
  // The phone joins Test Pit A with Dana's passcode sign-in, reads the company's records, and opens Dana's account.
  expect(g().connectCompany(PIT, { id: 'u-dana', email: '' })).toEqual({ ok: true });
  g().ensureReceiving();
  const ctx = (account: string) => ({ company: PIT.id, account, epoch: g().receiving!.epoch });
  g().applyStanding(ctx('u-dana'), { role: 'employee', name: { firstName: 'Dana', lastName: 'Fry' } });
  g().applyReceived(ctx('u-dana'), []);
  const dana = g().session!.employeeId;
  expect(g().employees.find((e) => e.id === dana)).toMatchObject({ firstName: 'Dana', lastName: 'Fry' });

  // Delete my account: the server deleted Dana's sign-in, and connection.ts let go of it (forgetDeletedSignIn);
  // then the store, which keeps the phone as it is, since Lee's account is on it.
  g().signInDeleted();
  g().disconnectCompany();
  expect(g().deleteMyAccount({ clearPhone: true })).toEqual({ ok: true, cleared: false });
  expect(g().receiving).toMatchObject({ role: 'none', name: null });

  // The company sign-in, for the next person: Pat.
  const { server, useServerAccount } = connection;
  server.crewAuth.mockImplementation(async (action: string): Promise<CrewAnswer> =>
    action === 'lookup'
      ? { kind: 'company', name: PIT.name, state: 'NV' }
      : { kind: 'signed_in', session: { accessToken: 'a-1', refreshToken: 'r-1', expiresAt: 1_900_000_000, userId: PATS_SIGN_IN.id }, company: { id: PIT.id, name: PIT.name }, waiting: false, join: null, othersSignedOut: true },
  );
  server.startCrewSession.mockImplementation(async () => {
    useServerAccount.setState({ known: true, account: PATS_SIGN_IN });
    return { ok: true, account: PATS_SIGN_IN };
  });
  server.myCompanies.mockResolvedValue({ ok: true, companies: [PIT] });
  server.myJoinRequests.mockResolvedValue({ ok: true, requests: [] });
  const root = createRoot();
  const settle = () => act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  const box = (id: string) => root.container.queryAll((n) => n.props.testID === id && typeof n.props.onChangeText === 'function')[0];
  const type = async (id: string, text: string) => {
    await act(async () => (box(id)!.props.onChangeText as (t: string) => void)(text));
    await settle();
  };
  /** A tap: the onPress of the nearest component around the view that has one. */
  const press = async (id: string) => {
    let fiber = root.container.queryAll((n) => n.props.testID === id)[0]?.unstable_fiber as Fiber;
    while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
    if (!fiber) throw new Error(`Nothing to press at ${id}.`);
    const onPress = fiber.memoizedProps!.onPress as () => void;
    await act(async () => onPress());
    await settle();
  };
  await act(async () => root.render(React.createElement(CompanySignInScreen, { navigation: { navigate: jest.fn() }, route: { key: 'CompanySignIn', name: 'CompanySignIn' } } as never)));
  await type('crew-code', 'abcd2345');
  await press('crew-mode-sign_in');
  // Nothing of Dana's is put in for Pat.
  const filled = { first: box('crew-first')?.props.value, last: box('crew-last')?.props.value };
  await type('crew-first', 'Pat');
  await type('crew-last', 'Ortiz');
  await type('crew-passcode', '582039');
  await press('crew-submit');
  expect(g().connectedCompany).toMatchObject({ id: PIT.id, userId: PATS_SIGN_IN.id });
  // The round reads Pat's own row of the roster and the company's records: the account that opens is Pat's.
  await act(async () => {
    g().applyStanding(ctx('u-pat'), { role: 'employee', name: { firstName: 'Pat', lastName: 'Ortiz' } });
    g().applyReceived(ctx('u-pat'), []);
  });
  const openedFor = g().employees.find((e) => e.id === g().session?.employeeId);
  await act(async () => root.unmount());

  expect({
    filled,
    openedFor: openedFor ? `${openedFor.firstName} ${openedFor.lastName}` : null,
    danasRecordHasAnAccount: g().accounts.some((a) => a.employeeId === dana),
  }).toEqual({ filled: { first: '', last: '' }, openedFor: 'Pat Ortiz', danasRecordHasAnAccount: false });
});
