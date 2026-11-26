/**
 * The Android-only notice on the Clock screen while the phone may hold the lunch-over notice back: it says why and
 * offers one button that opens the phone's Alarms & reminders setting.
 */
jest.mock('../../../components/icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));

type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): unknown } };

const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { OnTimeNotice } = require('../OnTimeNotice') as typeof import('../OnTimeNotice');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

async function show(onAllow: () => Promise<void>) {
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(OnTimeNotice, { onAllow })));
}
const shown = () => JSON.stringify(root!.container.toJSON());
function pressAllow() {
  const found = root!.container.queryAll((n) => n.props.testID === 'allow-on-time')[0];
  if (!found) throw new Error('No allow button here.');
  let fiber = found.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  return act(async () => (fiber!.memoizedProps!.onPress as () => void)());
}

it('says the lunch notice can come late and why, in plain words', async () => {
  await show(async () => undefined);
  expect(shown()).toContain('The lunch notice can come late on this phone');
  expect(shown()).toContain('Alarms & reminders');
  expect(shown()).toContain('Allow on-time notices');
});

it('asks the phone when the button is tapped', async () => {
  const onAllow = jest.fn(async () => undefined);
  await show(onAllow);
  await pressAllow();
  expect(onAllow).toHaveBeenCalledTimes(1);
});

it('asks once even when the button is tapped again while the phone is answering', async () => {
  let answer: () => void = () => undefined;
  const onAllow = jest.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
  await show(onAllow);
  await pressAllow();
  await pressAllow();
  expect(onAllow).toHaveBeenCalledTimes(1);
  await act(async () => answer());
});
