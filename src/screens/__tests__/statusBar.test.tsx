// The colour of the phone's status bar icons follows the screen in front. Three screens draw a coloured top
// under the status bar: the Clock screen (black off the clock, yellow on it, blue at lunch, red overdue), the
// result of a checklist and a signed pre shift exam. Each asks for white or dark icons to suit it, but only
// while it is the screen in front: a tab left open behind another, or a screen with another opened over it,
// asks for nothing, so the light screens get the app's own dark icons. With no signal the black strip across
// the top asks for white icons, and a coloured screen opened then cannot make them dark on it. The sign-in
// screens draw a dark band under the status bar too, and ask for white icons over it. React Native merges
// every status bar a screen draws in the order they were drawn, and on Android it hands the result to the
// phone; that is played here as the real App, its real navigator and those three real screens draw them,
// with the sign-in screens' real top, on an Android phone. Every other screen is a stand-in. Everyone and
// everything here is made up.
import type { Platform as PlatformType } from 'react-native';

import type { AreaExam, Equipment, Inspection } from '../../domain/types';

const mockText = (words: string) => () => require('react').createElement(require('react-native').Text, null, words);
/** A sign-in screen with its real top: the dark band both sign-in screens draw under the status bar. */
const mockSignIn = (words: string) => () => {
  const R = require('react');
  const { SignInHeader } = require('../../components/SignInHeader');
  return R.createElement(R.Fragment, null, R.createElement(SignInHeader, { company: null }), mockText(words)());
};
jest.mock('../../screens/auth/AuthScreen', () => ({ AuthScreen: mockSignIn('Auth') }));
jest.mock('../../screens/auth/CompanySignInScreen', () => ({ CompanySignInScreen: mockSignIn('CompanySignIn') }));
jest.mock('../../screens/equipment/ChecklistCardScreen', () => ({ ChecklistCardScreen: mockText('ChecklistCard') }));
jest.mock('../../screens/equipment/EndUseScreen', () => ({ EndUseScreen: mockText('EndUse') }));
jest.mock('../../screens/equipment/EquipmentScreen', () => ({ EquipmentScreen: mockText('Checklists') }));
jest.mock('../../screens/equipment/InspectionDetailScreen', () => ({ InspectionDetailScreen: mockText('InspectionDetail') }));
jest.mock('../../screens/equipment/InspectionScreen', () => ({ InspectionScreen: mockText('Inspection') }));
jest.mock('../../screens/equipment/MrfDetailScreen', () => ({ MrfDetailScreen: mockText('MrfDetail') }));
jest.mock('../../screens/equipment/MrfFormScreen', () => ({ MrfFormScreen: mockText('MrfForm') }));
jest.mock('../../screens/exam/AreaExamScreen', () => ({ AreaExamScreen: mockText('AreaExam') }));
jest.mock('../../screens/hours/HoursScreen', () => ({ HoursScreen: mockText('Hours') }));
jest.mock('../../screens/hours/ShiftDetailScreen', () => ({ ShiftDetailScreen: mockText('ShiftDetail') }));
jest.mock('../../screens/more/MoreScreen', () => ({ MoreScreen: mockText('More') }));
jest.mock('../../screens/more/CompanyScreen', () => ({ CompanyScreen: mockText('Company') }));
jest.mock('../../screens/more/DeleteAccountScreen', () => ({ DeleteAccountScreen: mockText('DeleteAccount') }));
jest.mock('../../screens/more/MyRecordsScreen', () => ({ MyRecordsScreen: mockText('MyRecords') }));
jest.mock('../../screens/more/SiteScreen', () => ({ SiteScreen: mockText('Site') }));
jest.mock('../../screens/more/StandardsScreen', () => ({ StandardsScreen: mockText('Standards') }));
jest.mock('../../screens/supervisor/AreaSheetsScreen', () => ({ AreaSheetsScreen: mockText('AreaSheets') }));
jest.mock('../../screens/supervisor/CrewScreen', () => ({ CrewScreen: mockText('Crew') }));
jest.mock('../../screens/supervisor/FleetScreen', () => ({ FleetScreen: mockText('Fleet') }));
jest.mock('../../screens/supervisor/MrfQueueScreen', () => ({ MrfQueueScreen: mockText('MrfQueue') }));
jest.mock('../../screens/supervisor/OnSiteScreen', () => ({ OnSiteScreen: mockText('OnSite') }));
jest.mock('../../screens/supervisor/PayrollEmployeeScreen', () => ({ PayrollEmployeeScreen: mockText('PayrollEmployee') }));
jest.mock('../../screens/supervisor/PayrollScreen', () => ({ PayrollScreen: mockText('Payroll') }));
jest.mock('../../screens/supervisor/RosterScreen', () => ({ RosterScreen: mockText('Roster') }));
jest.mock('../../screens/supervisor/SafetyLogScreen', () => ({ SafetyLogScreen: mockText('SafetyLog') }));
jest.mock('../../screens/supervisor/TimeLogsScreen', () => ({ TimeLogsScreen: mockText('TimeLogs') }));
// The app's own navigation container, with a handle on it to move about the app as a person would.
let mockNav: import('@react-navigation/native').NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null = null;
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const R = require('react');
  return {
    ...actual,
    NavigationContainer: (props: Record<string, unknown>) => {
      const ref = R.useMemo(() => actual.createNavigationContainerRef(), []);
      mockNav = ref;
      return R.createElement(actual.NavigationContainer, { ...props, ref });
    },
  };
});
// What the app starts once the records are read: no company server, no reminders, and signal set by each test.
jest.mock('../../services/connection', () => ({ CAN_CONNECT: false, watchConnection: () => () => undefined }));
jest.mock('../../services/reminders', () => ({ syncReminders: async () => undefined, watchReminders: () => () => undefined }));
jest.mock('../../services/sync', () => {
  const { create } = require('zustand');
  return { startSync: () => () => undefined, useSyncStatus: create(() => ({ online: true, server: false, waiting: 0 })) };
});
jest.mock('../../services/location', () => ({ locate: async () => ({ ok: false, reason: 'off' }) }));
jest.mock('../../services/notifications', () => ({
  requestNotificationPermission: jest.fn(async () => true),
  lunchNoticeState: jest.fn(async () => 'on'),
  onTimeNotices: jest.fn(async () => true),
  allowOnTimeNotices: jest.fn(async () => true),
  scheduleLocal: jest.fn(async () => undefined),
  cancelLocal: jest.fn(async () => undefined),
}));
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('@expo-google-fonts/barlow/500Medium', () => ({}));
jest.mock('@expo-google-fonts/barlow/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow/700Bold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/600SemiBold', () => ({}));
jest.mock('@expo-google-fonts/barlow-condensed/700Bold', () => ({}));
// lucide's files are not transformed under Jest; any icon draws nothing here.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// A store build: it holds nobody made up and names nobody. Set before anything below is required.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Root = { render(e: unknown): void; unmount(): void };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { NativeModules, Platform } = require('react-native') as { NativeModules: { StatusBarManager: { setStyle: jest.Mock } }; Platform: typeof PlatformType };
const App = (require('../../../App') as { default: React.ComponentType }).default;
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { useSyncStatus } = require('../../services/sync') as { useSyncStatus: { setState(s: { online: boolean }): void } };
const { CHECKLIST_ID } = require('../../domain/templates') as typeof import('../../domain/templates');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// An Android phone: there the merged style goes to the phone each time it is worked out.
let android: jest.ReplaceProperty<string> | null = null;
beforeEach(() => {
  android = jest.replaceProperty(Platform, 'OS', 'android');
  NativeModules.StatusBarManager.setStyle.mockClear();
  useSyncStatus.setState({ online: true });
});
afterEach(() => android?.restore());

let root: Root | null = null;
beforeAll(async () => {
  // The store reads what is saved (nothing, here) before each test sets what it found.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/**
 * What the phone was last told to draw the status bar icons as: 'light-content' (white) or 'dark-content'.
 * React Native works it out once the frame is drawn, and only then hands it to the phone.
 */
async function icons(): Promise<string | undefined> {
  await act(async () => {
    await new Promise<void>((r) => setImmediate(() => r()));
  });
  const calls = NativeModules.StatusBarManager.setStyle.mock.calls;
  return calls[calls.length - 1]?.[0];
}

const L5: Equipment = { id: 'eq-l5', unit: 'L-5', category: 'loader', make: 'Made-up', model: 'LX 1', status: 'out_of_service', meter: 400, meterUnit: 'hrs' };
/** Lee's checklist on L-5 with the brakes marked Bad Order, and no maintenance request yet. */
function badOrder(): Inspection {
  const now = Date.now();
  return {
    id: 'insp-bo',
    equipmentId: L5.id,
    category: L5.category,
    employeeId: 'emp-lee',
    templateId: CHECKLIST_ID,
    templateVersion: 1,
    startedAt: now - 600_000,
    submittedAt: now - 60_000,
    meter: 400,
    answers: [{ itemId: 'brakes', answer: 'bo', note: 'Parking brake does not hold' }],
    result: 'bad_order',
  };
}
/** Lee's pre shift exam of a made-up area, with nothing found. */
function exam(): AreaExam {
  const now = Date.now();
  return { id: 'exam-1', sheetId: 'made-up-yard', area: 'Made-up yard', employeeId: 'emp-lee', shift: 'day', startedAt: now - 600_000, submittedAt: now - 60_000, rows: [], conditions: [] };
}

/**
 * The app opened on Lee's own phone, as it opens on a phone: the loading view first, while the records are
 * read, then Lee signed in on the Clock tab, `on` the clock or off it, or nobody `signedIn` yet.
 */
async function opened({ on = false, signedIn = true } = {}) {
  useStore.setState({ hydrated: false, recordsUnreadable: false });
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(App)));
  await act(async () => {
    useStore.setState({ hydrated: true });
  });
  await act(async () => {
    useStore.getState().ensureSeeded();
    const { settings } = useStore.getState();
    const now = Date.now();
    useStore.setState({
      employees: [{ id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true }],
      accounts: [{ id: 'acct-lee', employeeId: 'emp-lee', email: '', provider: 'company', createdAt: 1 }],
      session: signedIn ? { accountId: 'acct-lee', employeeId: 'emp-lee' } : null,
      shifts: on ? [{ id: 'sh-lee', employeeId: 'emp-lee', clockIn: { at: now - 3_600_000, noLocation: 'off' }, lunches: [], breaks: [] }] : [],
      equipment: [L5],
      inspections: [badOrder()],
      exams: [exam()],
      mrfs: [],
      opLogs: [],
      toast: null,
      settings: {
        ...settings,
        company: { ...settings.company, name: 'Test Pit A', state: 'NV', pay: null, timeClock: undefined },
        site: { name: 'Test Pit A', center: { lat: 10, lng: 10 }, radiusM: 500 },
      },
    });
  });
}

async function to(name: string, params?: object) {
  await act(async () => (mockNav?.navigate as unknown as (name: string, params?: object) => void)(name, params));
}
async function back() {
  await act(async () => mockNav?.goBack());
}

describe('the status bar icons on Android', () => {
  it('are white on the black Clock screen off the clock, and dark again on the light tabs', async () => {
    await opened();
    expect(await icons()).toBe('light-content');
    await to('Equipment');
    expect(await icons()).toBe('dark-content');
    await to('More');
    expect(await icons()).toBe('dark-content');
    // Back on the Clock tab: white again on its black top.
    await to('Clock');
    expect(await icons()).toBe('light-content');
  });

  it('are dark on the yellow Clock screen on the clock', async () => {
    await opened({ on: true });
    expect(await icons()).toBe('dark-content');
    await to('Hours');
    expect(await icons()).toBe('dark-content');
  });

  it('are dark on a light screen opened over the Clock tab', async () => {
    await opened();
    await to('MyRecords');
    expect(await icons()).toBe('dark-content');
  });

  it('are white on a Bad Order, and dark on the maintenance request form opened over it', async () => {
    await opened({ on: true });
    await to('InspectionResult', { inspectionId: 'insp-bo' });
    expect(await icons()).toBe('light-content');
    await to('MrfForm', { equipmentId: L5.id, inspectionId: 'insp-bo' });
    expect(await icons()).toBe('dark-content');
    // Back from the form, on the Bad Order again.
    await back();
    expect(await icons()).toBe('light-content');
  });

  it('are white on a signed exam, and dark on what is opened over it', async () => {
    await opened();
    await to('AreaExamDetail', { examId: 'exam-1' });
    expect(await icons()).toBe('light-content');
    await to('MrfDetail', { mrfId: 'none' });
    expect(await icons()).toBe('dark-content');
  });

  it('are white on the sign-in screen’s dark band, when the app opens and after signing out', async () => {
    await opened({ signedIn: false });
    expect(await icons()).toBe('light-content');
    // Signed in, on a light tab: the sign-in screen has gone, and its white icons with it.
    await act(async () => {
      useStore.setState({ session: { accountId: 'acct-lee', employeeId: 'emp-lee' } });
    });
    await to('Equipment');
    expect(await icons()).toBe('dark-content');
    // Signed out from there: white again on the band.
    await act(async () => {
      useStore.getState().signOut();
    });
    expect(useStore.getState().session).toBeNull();
    expect(await icons()).toBe('light-content');
  });

  it('are white under the black no-signal strip, even on the yellow Clock screen opened after it', async () => {
    useSyncStatus.setState({ online: false });
    await opened({ on: true });
    expect(await icons()).toBe('light-content');
    await to('Equipment');
    expect(await icons()).toBe('light-content');
    await to('Clock');
    expect(await icons()).toBe('light-content');
    // Signal back: the strip goes, and the yellow screen has its dark icons.
    await act(async () => useSyncStatus.setState({ online: true }));
    expect(await icons()).toBe('dark-content');
  });
});
