// Both sign-in screens draw a dark band under the status bar, and ask for white icons over it (SignInHeader). The
// band is the top of a form that scrolls: tap Sign up and scroll, or let the keyboard push the form up, and the band
// goes up with it, while the icons stay white over the light page. So each screen keeps a strip of the band's own
// colour under the status bar, outside the form, drawn over it, as tall as the status bar: at rest it lies on the
// band's own top in the band's own colour, so the screen looks as it did, and scrolled, the icons are still on dark.
// Where nothing is over the top of the screen (a browser, as a rule), there is no strip, so it covers nothing.
// Drawn here as the app draws them, each in a navigator, with the real screens and a status bar 36 points tall; the
// company server's calls are stand-ins, so no request leaves the test. Everyone here is made up.
jest.mock('../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../components/Brand', () => ({ CompanyLogoPlate: () => null, MineMusterLogo: () => null, HAS_LOGO_ART: false }));
jest.mock('../../components/WebPageLinks', () => ({ WebPageLinks: () => null }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// The company server, as connection.ts hands it to the screen: nobody signed in to it, and each call a stub.
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

// A store build: it connects, holds nobody made up and names nobody.
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});
for (const key of ['EXPO_PUBLIC_ROSTER', 'EXPO_PUBLIC_ROSTER_OWNER', 'EXPO_PUBLIC_AREA_SHEETS', 'EXPO_PUBLIC_COMPANY']) delete process.env[key];
Object.assign(process.env, {
  EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
  EXPO_PUBLIC_DEMO: '0',
  EXPO_PUBLIC_SAMPLE_CREW: '0',
});

interface Drawn {
  type: string;
  props: Record<string, unknown>;
  parent: Drawn | null;
  children: (Drawn | string)[];
}
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Drawn) => boolean): Drawn[] } };
const React: typeof import('react') = require('react');
const { StyleSheet } = require('react-native') as typeof import('react-native');
const { SafeAreaProvider } = require('react-native-safe-area-context') as typeof import('react-native-safe-area-context');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const nav = require('@react-navigation/native') as typeof import('@react-navigation/native');
const { createNativeStackNavigator } = require('@react-navigation/native-stack') as typeof import('@react-navigation/native-stack');
const { AuthScreen } = require('../auth/AuthScreen') as typeof import('../auth/AuthScreen');
const { CompanySignInScreen } = require('../auth/CompanySignInScreen') as typeof import('../auth/CompanySignInScreen');
const { color } = require('../../theme/theme') as typeof import('../../theme/theme');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The status bar's height on the phone drawn here. */
const TOP = 36;

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/** The screen as the app draws it: in a navigator of its own, under a status bar `top` points tall. */
async function draw(name: string, screen: React.ComponentType<never>, top = TOP): Promise<Root> {
  const r = createRoot();
  root = r;
  const Stack = createNativeStackNavigator();
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top, bottom: 0, left: 0, right: 0 } };
  await act(async () =>
    r.render(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: metrics } as never,
        React.createElement(
          nav.NavigationContainer,
          null,
          React.createElement(Stack.Navigator, { screenOptions: { headerShown: false } } as never, React.createElement(Stack.Screen, { name, component: screen } as never)),
        ),
      ),
    ),
  );
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  return r;
}

const one = (r: Root, testID: string): Drawn => {
  const found = r.container.queryAll((n) => n.props.testID === testID);
  if (found.length !== 1) throw new Error(`Found ${found.length} of ${testID}.`);
  return found[0];
};
const within = (node: Drawn, ancestor: Drawn) => {
  for (let at = node.parent; at; at = at.parent) if (at === ancestor) return true;
  return false;
};
const styleOf = (node: Drawn) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe.each([
  ['Auth', AuthScreen, 'auth-screen'],
  ['CompanySignIn', CompanySignInScreen, 'company-sign-in'],
] as const)('the %s screen', (name, screen, form) => {
  it('keeps a strip of the band’s colour under the status bar, over the form, however far it is scrolled', async () => {
    const r = await draw(name, screen as React.ComponentType<never>);
    const scrolled = one(r, form);
    const band = one(r, 'sign-in-band');
    const strip = one(r, 'sign-in-status-strip');

    // The band is the top of the form, and scrolls with it, from under the status bar down.
    expect(within(band, scrolled)).toBe(true);
    expect(styleOf(band)).toMatchObject({ backgroundColor: color.ink, paddingTop: expect.any(Number) });
    expect(styleOf(band).paddingTop as number).toBeGreaterThanOrEqual(TOP);

    // The strip: across the top, as tall as the status bar, in the band's own colour. At rest it lies on the band's
    // top, so the screen looks as it did. It never takes a tap meant for what is under it.
    expect(styleOf(strip)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, height: TOP, backgroundColor: styleOf(band).backgroundColor });
    expect(strip.props.pointerEvents).toBe('none');

    // Not in the form, so it stays where it is as the form scrolls under it; drawn after it, so it is over it.
    expect(within(strip, scrolled)).toBe(false);
    const shared = strip.parent!;
    const formsPlace = shared.children.findIndex((child) => child === scrolled || (typeof child !== 'string' && within(scrolled, child)));
    expect(formsPlace).toBeGreaterThanOrEqual(0);
    expect(shared.children.indexOf(strip)).toBeGreaterThan(formsPlace);
  });

  it('draws no strip where nothing is over the top of the screen, as in a browser', async () => {
    const r = await draw(name, screen as React.ComponentType<never>, 0);
    expect(r.container.queryAll((n) => n.props.testID === 'sign-in-status-strip')).toEqual([]);
    expect(one(r, 'sign-in-band')).toBeTruthy();
  });
});
