// The result screen after an equipment checklist. On a Bad Order or a defect it is where the maintenance
// request is filled out and, after a defect, where the person says whether they run the unit or park it. On
// iPhone its buttons are the only way off it: the screen has no back gesture. On Android the back button and
// the back gesture must not skip what is still owed there either: they say what is left to do instead, work
// as ever on the maintenance request opened on top of it, and work again once nothing is owed. For anyone
// who left the screen before (an older version, the app closed), the checklist itself offers the request.
// Android's handling of a back press is played here as React Native's BackHandler does it on Android: the
// listener added last is asked first, until one says it dealt with the press. Everyone and everything here
// is made up.
import type { Equipment, Inspection } from '../../domain/types';
import type { RootStackParamList } from '../../navigation/types';

jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// A store build: it holds nobody made up and names nobody. Set before anything below is required.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, { EXPO_PUBLIC_DEMO: '0', EXPO_PUBLIC_SAMPLE_CREW: '0' });

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[] } };
const React: typeof import('react') = require('react');
const { BackHandler, Platform, Text } = require('react-native') as typeof import('react-native');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const nav = require('@react-navigation/native') as typeof import('@react-navigation/native');
const { createNativeStackNavigator } = require('@react-navigation/native-stack') as typeof import('@react-navigation/native-stack');
const { SafeAreaProvider } = require('react-native-safe-area-context') as typeof import('react-native-safe-area-context');
const { InspectionResultScreen } = require('../equipment/InspectionResultScreen') as typeof import('../equipment/InspectionResultScreen');
const { InspectionDetailScreen } = require('../equipment/InspectionDetailScreen') as typeof import('../equipment/InspectionDetailScreen');
const { useStore } = require('../../store/useStore') as typeof import('../../store/useStore');
const { CHECKLIST_ID } = require('../../domain/templates') as typeof import('../../domain/templates');
const { space } = require('../../theme/theme') as typeof import('../../theme/theme');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (type: unknown, props?: object | null, ...children: unknown[]) => React.ReactElement;

// An Android phone: the screens listen for the back button only there.
let android: jest.ReplaceProperty<string> | null = null;
beforeEach(() => {
  android = jest.replaceProperty(Platform, 'OS', 'android');
});
afterEach(() => android?.restore());

/** The back button's listeners, as React Native keeps them on Android, oldest first. */
type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
const listeners: BackListener[] = [];
jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_name, handler) => {
  if (!listeners.includes(handler)) listeners.push(handler);
  return {
    remove: () => {
      const at = listeners.indexOf(handler);
      if (at !== -1) listeners.splice(at, 1);
    },
  };
});
/** A press of Android's back button. False when nothing dealt with it, and Android would put the app away. */
async function pressBack(): Promise<boolean> {
  let dealt = false;
  await act(async () => {
    for (let i = listeners.length - 1; i >= 0 && !dealt; i -= 1) dealt = listeners[i]({ type: 'hardwareBackPress', timeStamp: 0 }) === true;
  });
  return dealt;
}

const L5: Equipment = { id: 'eq-l5', unit: 'L-5', category: 'loader', make: 'Made-up', model: 'LX 1', status: 'out_of_service', meter: 400, meterUnit: 'hrs' };
/** Lee's checklist on L-5: passed, or with the brakes marked Bad Order. */
function checklist(result: Inspection['result'], more: Partial<Inspection> = {}): Inspection {
  const now = Date.now();
  return {
    id: `insp-${result}`,
    equipmentId: L5.id,
    category: L5.category,
    employeeId: 'emp-lee',
    templateId: CHECKLIST_ID,
    templateVersion: 1,
    startedAt: now - 600_000,
    submittedAt: now - 60_000,
    meter: 400,
    answers: [result === 'pass' ? { itemId: 'brakes', answer: 'ok' } : { itemId: 'brakes', answer: 'bo', note: 'Parking brake does not hold' }],
    result,
    ...more,
  };
}

/** Lee's own phone, Lee signed in, with Lee's checklist on record. Kim is a supervisor. */
function leesPhone(inspection: Inspection, more: { equipment?: Equipment[]; signedIn?: 'emp-lee' | 'emp-kim' } = {}) {
  useStore.getState().ensureSeeded();
  const who = more.signedIn ?? 'emp-lee';
  useStore.setState({
    employees: [
      { id: 'emp-lee', firstName: 'Lee', lastName: 'Park', role: 'employee', active: true },
      { id: 'emp-kim', firstName: 'Kim', lastName: 'Ruiz', role: 'supervisor', active: true },
    ],
    accounts: [{ id: `acct-${who}`, employeeId: who, email: '', provider: 'company', createdAt: 1 }],
    session: { accountId: `acct-${who}`, employeeId: who },
    equipment: more.equipment ?? [L5],
    inspections: [inspection],
    mrfs: [],
    opLogs: [],
    toast: null,
  });
}
/** The maintenance request for the checklist, sent as the form sends it. */
async function sendRequest(inspectionId: string) {
  await act(async () => {
    expect(useStore.getState().createMrf({ equipmentId: L5.id, priority: 'high', description: 'Brake test & function: Parking brake does not hold', taggedOut: false, inspectionId })).toMatchObject({ ok: true });
  });
}

const standIn = (name: string) => () => h(Text, null, name);
const Stack = createNativeStackNavigator<RootStackParamList>();
let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/**
 * The app's stack with the screen under test opened over the tabs, as a signed checklist opens its result,
 * on a phone whose navigation bar takes `bottom` at the foot of the screen.
 */
async function opened(screen: 'InspectionResult' | 'InspectionDetail', inspectionId: string, bottom = 0) {
  const ref = nav.createNavigationContainerRef<RootStackParamList>();
  root = createRoot();
  const r = root;
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, bottom, left: 0, right: 0 } };
  await act(async () => {
    r.render(
      h(
        SafeAreaProvider,
        { initialMetrics: metrics },
        h(
          nav.NavigationContainer,
          { ref },
          h(
            Stack.Navigator,
            { screenOptions: { headerShown: false } },
            h(Stack.Screen, { name: 'Main', component: standIn('Main') }),
            h(Stack.Screen, { name: 'InspectionResult', component: InspectionResultScreen }),
            h(Stack.Screen, { name: 'InspectionDetail', component: InspectionDetailScreen }),
            h(Stack.Screen, { name: 'MrfForm', component: standIn('MrfForm') }),
            h(Stack.Screen, { name: 'MrfDetail', component: standIn('MrfDetail') }),
            h(Stack.Screen, { name: 'ChecklistCard', component: standIn('ChecklistCard') }),
          ),
        ),
      ),
    );
  });
  await act(async () => ref.navigate(screen, { inspectionId }));
  return { ref, here: () => ref.getCurrentRoute()?.name };
}

const byId = (id: string) => root!.container.queryAll((n) => n.props.testID === id);
/** A prop of the nearest component around a view that has it. */
function propOf(n: Node, prop: string): unknown {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && fiber.memoizedProps?.[prop] === undefined) fiber = fiber.return;
  return fiber?.memoizedProps?.[prop];
}
async function tap(id: string) {
  const [node] = byId(id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => (propOf(node, 'onPress') as () => void)());
}

describe('Android’s back button on the result of a checklist', () => {
  it('on a Bad Order with no maintenance request yet, says to fill it out and stays', async () => {
    leesPhone(checklist('bad_order'));
    const { here } = await opened('InspectionResult', 'insp-bad_order');
    expect(byId('send-mrf')).not.toHaveLength(0);
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('InspectionResult');
    expect(useStore.getState().toast).toMatchObject({ message: 'Fill out the maintenance request first', tone: 'warn' });
  });

  it('works on the maintenance request opened on top, and leaves the result once the request is in', async () => {
    leesPhone(checklist('bad_order'));
    const { here } = await opened('InspectionResult', 'insp-bad_order');
    await tap('send-mrf');
    expect(here()).toBe('MrfForm');
    // Back on the form goes back to the result, as ever: the result screen is not in front.
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('InspectionResult');
    expect(useStore.getState().toast).toBeNull();

    await sendRequest('insp-bad_order');
    expect(byId('result-done')).not.toHaveLength(0);
    // Nothing is owed on a Bad Order once its request is in: back goes where Done goes.
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('Main');
    expect(useStore.getState().toast).toBeNull();
  });

  it('after a defect, holds until the request is in and the person has said whether they run it or park it', async () => {
    leesPhone(checklist('defect'));
    const { here } = await opened('InspectionResult', 'insp-defect');
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('InspectionResult');
    expect(useStore.getState().toast).toMatchObject({ message: 'Fill out the maintenance request first', tone: 'warn' });

    await sendRequest('insp-defect');
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('InspectionResult');
    expect(useStore.getState().toast).toMatchObject({ message: 'Say whether you run it or park it', tone: 'warn' });

    // The choice's own buttons are never held up by it.
    await tap('decide-park');
    expect(useStore.getState().inspections[0]?.decision).toBe('parked');
    expect(here()).toBe('Main');
  });

  it('on a pass, goes back as ever, and the screen listens for nothing', async () => {
    leesPhone(checklist('pass'));
    const before = listeners.length;
    const { here } = await opened('InspectionResult', 'insp-pass');
    expect(byId('result-pass')).not.toHaveLength(0);
    // Only the navigator's own listener, which the stack had before the result opened.
    expect(listeners.length).toBe(before + 1);
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('Main');
    expect(useStore.getState().toast).toBeNull();
  });

  it('listens for nothing on an iPhone, which has no back button and no back gesture on this screen', async () => {
    android?.restore();
    leesPhone(checklist('bad_order'));
    const before = listeners.length;
    await opened('InspectionResult', 'insp-bad_order');
    expect(byId('send-mrf')).not.toHaveLength(0);
    // Only the navigator's own listener.
    expect(listeners.length).toBe(before + 1);
  });

  it('never holds a screen that shows nothing: the unit was taken out of the fleet meanwhile', async () => {
    leesPhone(checklist('bad_order'), { equipment: [] });
    const { here } = await opened('InspectionResult', 'insp-bad_order');
    expect(byId('result-bad_order')).toHaveLength(0);
    expect(await pressBack()).toBe(true);
    expect(here()).toBe('Main');
  });
});

describe('the foot of the result screen', () => {
  it.each([['bad_order'], ['defect'], ['pass']] as const)('leaves room for the phone’s navigation bar under the last button (%s)', async (result) => {
    leesPhone(checklist(result));
    await opened('InspectionResult', `insp-${result}`, 48);
    const [scroll] = byId(`result-${result}`);
    expect(propOf(scroll!, 'contentContainerStyle')).toMatchObject({ paddingBottom: space.xxl + 48 });
  });

  it('keeps its own space where the phone has no bar there', async () => {
    leesPhone(checklist('bad_order'));
    await opened('InspectionResult', 'insp-bad_order', 0);
    const [scroll] = byId('result-bad_order');
    expect(propOf(scroll!, 'contentContainerStyle')).toMatchObject({ paddingBottom: space.xxl });
  });
});

describe('a checklist left with no maintenance request', () => {
  it.each([['bad_order'], ['defect']] as const)('offers the person who signed it the request, linked to the checklist (%s)', async (result) => {
    leesPhone(checklist(result));
    const { ref } = await opened('InspectionDetail', `insp-${result}`);
    expect(byId('detail-send-mrf')).not.toHaveLength(0);
    await tap('detail-send-mrf');
    expect(ref.getCurrentRoute()).toMatchObject({ name: 'MrfForm', params: { equipmentId: L5.id, inspectionId: `insp-${result}` } });
  });

  it('offers nothing on a pass, once a request is in, to anyone else, or for a unit no longer in the fleet', async () => {
    leesPhone(checklist('pass'));
    await opened('InspectionDetail', 'insp-pass');
    expect(byId('inspection-detail')).not.toHaveLength(0);
    expect(byId('detail-send-mrf')).toHaveLength(0);
    await act(async () => root!.unmount());
    root = null;

    leesPhone(checklist('bad_order'));
    await sendRequest('insp-bad_order');
    await opened('InspectionDetail', 'insp-bad_order');
    expect(byId('inspection-detail')).not.toHaveLength(0);
    expect(byId('detail-send-mrf')).toHaveLength(0);
    await act(async () => root!.unmount());
    root = null;

    // A supervisor looking at Lee's checklist: the request is Lee's to send.
    leesPhone(checklist('bad_order'), { signedIn: 'emp-kim' });
    await opened('InspectionDetail', 'insp-bad_order');
    expect(byId('inspection-detail')).not.toHaveLength(0);
    expect(byId('detail-send-mrf')).toHaveLength(0);
    await act(async () => root!.unmount());
    root = null;

    leesPhone(checklist('bad_order'), { equipment: [] });
    await opened('InspectionDetail', 'insp-bad_order');
    expect(byId('inspection-detail')).not.toHaveLength(0);
    expect(byId('detail-send-mrf')).toHaveLength(0);
  });
});
