// Where a person lands when their view changes under them, in a build that connects to a company server
// (CAN_CONNECT), the build the stores get. Its signed-out view opens on the company sign-in. Deleting the
// account on the phone ends the session, and the signed-out view is the sign-in screen alone: no screen
// of the signed-in view is left on the stack, not even DeleteAccount, which both views have. The real
// RootNavigator is drawn; only the screens are stand-ins, each showing its own name. Everyone here is
// made up.
const mockScreen = (name: string) => {
  const R = require('react');
  const { Text } = require('react-native');
  return () => R.createElement(Text, null, name);
};
jest.mock('../../screens/auth/AuthScreen', () => ({ AuthScreen: mockScreen('Auth') }));
jest.mock('../../screens/auth/CompanySignInScreen', () => ({ CompanySignInScreen: mockScreen('CompanySignIn') }));
jest.mock('../../screens/clock/ClockScreen', () => ({ ClockScreen: mockScreen('Clock') }));
jest.mock('../../screens/equipment/ChecklistCardScreen', () => ({ ChecklistCardScreen: mockScreen('ChecklistCard') }));
jest.mock('../../screens/equipment/EndUseScreen', () => ({ EndUseScreen: mockScreen('EndUse') }));
jest.mock('../../screens/equipment/EquipmentScreen', () => ({ EquipmentScreen: mockScreen('Equipment') }));
jest.mock('../../screens/equipment/InspectionDetailScreen', () => ({ InspectionDetailScreen: mockScreen('InspectionDetail') }));
jest.mock('../../screens/equipment/InspectionResultScreen', () => ({ InspectionResultScreen: mockScreen('InspectionResult') }));
jest.mock('../../screens/equipment/InspectionScreen', () => ({ InspectionScreen: mockScreen('Inspection') }));
jest.mock('../../screens/equipment/MrfDetailScreen', () => ({ MrfDetailScreen: mockScreen('MrfDetail') }));
jest.mock('../../screens/equipment/MrfFormScreen', () => ({ MrfFormScreen: mockScreen('MrfForm') }));
jest.mock('../../screens/exam/AreaExamDetailScreen', () => ({ AreaExamDetailScreen: mockScreen('AreaExamDetail') }));
jest.mock('../../screens/exam/AreaExamScreen', () => ({ AreaExamScreen: mockScreen('AreaExam') }));
jest.mock('../../screens/hours/HoursScreen', () => ({ HoursScreen: mockScreen('Hours') }));
jest.mock('../../screens/hours/ShiftDetailScreen', () => ({ ShiftDetailScreen: mockScreen('ShiftDetail') }));
jest.mock('../../screens/more/MoreScreen', () => ({ MoreScreen: mockScreen('More') }));
jest.mock('../../screens/more/CompanyScreen', () => ({ CompanyScreen: mockScreen('Company') }));
jest.mock('../../screens/more/DeleteAccountScreen', () => ({ DeleteAccountScreen: mockScreen('DeleteAccount') }));
jest.mock('../../screens/more/MyRecordsScreen', () => ({ MyRecordsScreen: mockScreen('MyRecords') }));
jest.mock('../../screens/more/SiteScreen', () => ({ SiteScreen: mockScreen('Site') }));
jest.mock('../../screens/more/StandardsScreen', () => ({ StandardsScreen: mockScreen('Standards') }));
jest.mock('../../screens/more/CompanyAccountScreen', () => ({ CompanyAccountScreen: mockScreen('CompanyAccount') }));
jest.mock('../../screens/supervisor/AreaSheetsScreen', () => ({ AreaSheetsScreen: mockScreen('AreaSheets') }));
jest.mock('../../screens/supervisor/CrewScreen', () => ({ CrewScreen: mockScreen('Crew') }));
jest.mock('../../screens/supervisor/FleetScreen', () => ({ FleetScreen: mockScreen('Fleet') }));
jest.mock('../../screens/supervisor/MrfQueueScreen', () => ({ MrfQueueScreen: mockScreen('MrfQueue') }));
jest.mock('../../screens/supervisor/OnSiteScreen', () => ({ OnSiteScreen: mockScreen('OnSite') }));
jest.mock('../../screens/supervisor/PayrollEmployeeScreen', () => ({ PayrollEmployeeScreen: mockScreen('PayrollEmployee') }));
jest.mock('../../screens/supervisor/PayrollScreen', () => ({ PayrollScreen: mockScreen('Payroll') }));
jest.mock('../../screens/supervisor/RosterScreen', () => ({ RosterScreen: mockScreen('Roster') }));
jest.mock('../../screens/supervisor/SafetyLogScreen', () => ({ SafetyLogScreen: mockScreen('SafetyLog') }));
jest.mock('../../screens/supervisor/TimeLogsScreen', () => ({ TimeLogsScreen: mockScreen('TimeLogs') }));
// The store builds connect: CAN_CONNECT is true there. Only that constant of connection.ts is read here,
// and a test turns it off to see a build that connects to no server.
let mockConnects = true;
jest.mock('../../services/connection', () => ({
  get CAN_CONNECT() {
    return mockConnects;
  },
}));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The tab bar's icons: lucide's files are not transformed under Jest; any icon draws nothing here.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));

// The build the stores get: it connects (EXPO_PUBLIC_DEMO=0, a server named), with its own made-up roster.
// Set before anything below is required, so config.ts, useStore.ts and RootNavigator.tsx read it.
const savedEnv = { ...process.env };
for (const key of ['EXPO_PUBLIC_SAMPLE_CREW', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, {
  EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
  EXPO_PUBLIC_DEMO: '0',
  EXPO_PUBLIC_ROSTER: 'Fry, Dana | Loader Operator\nPark, Lee | Crusher',
});
afterAll(() => {
  process.env = savedEnv;
});

type Nav = typeof import('@react-navigation/native');
type Root = typeof import('../RootNavigator');
type Store = typeof import('../../store/useStore');

const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => { render(e: unknown): void; unmount(): void } };
const nav: Nav = require('@react-navigation/native');
const { RootNavigator }: Root = require('../RootNavigator');
const { useStore }: Store = require('../../store/useStore');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: { render(e: unknown): void; unmount(): void } | null = null;
afterEach(async () => {
  const r = renderer;
  renderer = null;
  if (r) await act(async () => r.unmount());
});

async function mounted() {
  const ref = nav.createNavigationContainerRef();
  const s = () => useStore.getState();
  s().resetDemo();
  s().ensureSeeded();
  renderer = createRoot();
  const r = renderer;
  await act(async () => {
    r.render(React.createElement(nav.NavigationContainer, { ref } as never, React.createElement(RootNavigator)));
  });
  /** The names of the routes on the root stack, bottom first. */
  const stack = () => (ref.getRootState()?.routes ?? []).map((r) => r.name);
  return { ref, s, stack };
}

describe('after Delete my account deletes the account on the phone', () => {
  it.each([[['DeleteAccount']], [['CompanyAccount', 'DeleteAccount']]])('lands on the sign-in screen alone, opened by way of %j', async (via) => {
    const { ref, s, stack } = await mounted();
    await act(async () => {
      expect(s().signUp({ firstName: 'Dana', lastName: 'Fry', email: 'dana@example.com', password: 'haulroad88' })).toMatchObject({ ok: true });
    });
    expect(ref.getCurrentRoute()?.name).toBe('Clock');
    for (const name of via) await act(async () => ref.navigate(name as never));
    expect(ref.getCurrentRoute()?.name).toBe('DeleteAccount');
    // The screen's own last step: the store deletes the account, and the session with it.
    await act(async () => {
      expect(s().deleteMyAccount({ clearPhone: false })).toEqual({ ok: true, cleared: false });
    });
    expect(s().session).toBeNull();
    expect({ current: ref.getCurrentRoute()?.name, stack: stack() }).toEqual({ current: 'CompanySignIn', stack: ['CompanySignIn'] });
  });

  it('opens the signed-in view on its first screen after signing in again', async () => {
    const { ref, s, stack } = await mounted();
    await act(async () => {
      expect(s().signUp({ firstName: 'Lee', lastName: 'Park', email: 'lee@example.com', password: 'crusher77' })).toMatchObject({ ok: true });
    });
    await act(async () => ref.navigate('DeleteAccount' as never));
    await act(async () => s().signOut());
    expect(stack()).toEqual(['CompanySignIn']);
    await act(async () => {
      expect(s().signIn('lee@example.com', 'crusher77')).toEqual({ ok: true });
    });
    expect(stack()).toEqual(['Main']);
  });
});

describe('the first screen', () => {
  it('in a build with a server the first screen is the company sign-in', async () => {
    const { ref, stack } = await mounted();
    expect({ current: ref.getCurrentRoute()?.name, stack: stack() }).toEqual({ current: 'CompanySignIn', stack: ['CompanySignIn'] });
  });

  it('a build that connects to no server opens on the sign-in kept on the phone, as before', async () => {
    mockConnects = false;
    try {
      const { ref, stack } = await mounted();
      expect({ current: ref.getCurrentRoute()?.name, stack: stack() }).toEqual({ current: 'Auth', stack: ['Auth'] });
      // Nothing of the company's server is a route there: no company sign-in, and no deleting a company sign-in signed out.
      expect(ref.getRootState()?.routeNames).toEqual(['Auth']);
    } finally {
      mockConnects = true;
    }
  });
});
