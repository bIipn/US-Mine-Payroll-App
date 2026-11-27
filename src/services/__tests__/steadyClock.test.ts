/**
 * The steady clock the Android records' copies are settled by (recordCopies.ts) is performance.now, and their rules
 * count on React Native reading it from std::chrono::steady_clock, which on Android counts from the phone's start
 * (CLOCK_MONOTONIC) and stops while it sleeps: a copy whose steady time is above now was written before the phone last
 * started, so it is on the disk, and a start of the app a few seconds long can set its copies beside an earlier
 * start's. A clock that counted from the app's start would make both untrue, and a power cut could then leave nothing
 * whole to read. React Native's own comment says this "should be carefully changed eventually": these tests read its
 * source as it is installed and fail once it no longer reads that clock, so an upgrade that changes it is caught here,
 * before it ships, and the rules are looked at again.
 */

// This project has no Node types, so the file system is asked for by name with the call used here.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');

const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));
const native = (name: string) => fs.readFileSync(`${root}/node_modules/react-native/${name}`, 'utf8');

/** The body of the C++ function whose definition starts at `at` in `source`: from its first brace to the one that closes it. */
function bodyAt(source: string, at: number): string {
  expect(at).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('No closing brace');
}
const bodyOf = (source: string, head: string) => bodyAt(source, source.indexOf(head));

/** Code with its comments taken out, so that a comment that names a call is not taken for the call. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('performance.now in React Native, as the records copies count on it', () => {
  it('is the global performance of the app, made by React Native’s own Performance', () => {
    expect(code(native('src/private/setup/setUpDefaultReactNativeEnvironment.js'))).toMatch(/require\('\.\/setUpPerformance'\)\.default\(\)/);
    expect(code(native('src/private/setup/setUpPerformance.js'))).toMatch(/global\.performance = new Performance\(\)/);
    const performance = code(native('src/private/webapis/performance/Performance.js'));
    expect(performance).toMatch(/const \{\s*now,[^}]*\}\s*=\s*NativePerformance;/);
    expect(performance).toMatch(/now: \(\) => DOMHighResTimeStamp = now;/);
  });

  it('is NativePerformance::now, which returns HighResTimeStamp::now()', () => {
    const now = code(bodyOf(native('ReactCommon/react/nativemodule/webperformance/NativePerformance.cpp'), 'HighResTimeStamp NativePerformance::now('));
    expect(now.trim()).toBe('return HighResTimeStamp::now();');
  });

  it('reads std::chrono::steady_clock on Android, and hands it on from that clock’s own start', () => {
    const primitives = code(native('ReactCommon/react/timing/primitives.h'));
    expect(bodyOf(primitives, 'static HighResTimeStamp now() noexcept').trim()).toBe('return HighResTimeStamp(chronoNow());');
    // Every chronoNow there is (with a time stamp provider for tests, and without) reads steady_clock off the iPhone.
    const reads = [...primitives.matchAll(/time_point chronoNow\(\)/g)].map((m) => bodyAt(primitives, m.index));
    expect(reads.length).toBeGreaterThan(0);
    for (const body of reads) {
      expect(body).toMatch(/#else\s*return std::chrono::steady_clock::now\(\);\s*#endif/);
      expect(body).not.toMatch(/system_clock|high_resolution_clock/);
    }
    // A time stamp as JavaScript gets it: from the steady clock's own start, with nothing taken off.
    expect(primitives).toContain('return HighResDuration(chronoTimePoint_.time_since_epoch()).toDOMHighResTimeStamp();');
  });
});
