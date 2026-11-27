// Which way an export goes on Android, asked in a sheet once the file is made: Open on this phone (only when
// an app on the phone opens the type), Save to phone (a folder the person picks or makes), or Send to another
// app (the share sheet). What went wrong last time is said on the sheet. Closing it, or leaving the screen,
// sends the file nowhere. Everything here is made up.
jest.mock('../icons', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) }));
jest.mock('../../services/haptics', () => ({ haptic: new Proxy({}, { get: () => () => undefined }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

import type { ChooseFileWay, FileChoice } from '../../services/saveFile';

type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> } | null;
type Node = { props: Record<string, unknown>; unstable_fiber: unknown };
type Json = { children?: (Json | string)[] | null } | string | null;
type Root = { render(e: unknown): void; unmount(): void; container: { queryAll(p: (n: Node) => boolean): Node[]; toJSON(): Json | Json[] } };
const React: typeof import('react') = require('react');
const { createRoot } = require('test-renderer') as { createRoot: () => Root };
const { useFileChoice } = require('../FileChoice') as typeof import('../FileChoice');
const act = (React as unknown as { act: (fn: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const byId = (root: Root, id: string) => root.container.queryAll((n) => n.props.testID === id);
function text(json: Json | Json[]): string {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(text).join(' ');
  return (json.children ?? []).map(text).join(' ');
}
const shown = (root: Root) => text(root.container.toJSON());
function pressOf(n: Node): () => void {
  let fiber = n.unstable_fiber as Fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Nothing to press here.');
  return fiber.memoizedProps!.onPress as () => void;
}
async function tap(root: Root, id: string) {
  const [node] = byId(root, id);
  if (!node) throw new Error(`No ${id} on the screen.`);
  await act(async () => pressOf(node)());
}

let choose: ChooseFileWay | null = null;
function Screen() {
  const files = useFileChoice();
  choose = files.choose;
  return files.sheet;
}

let root: Root | null = null;
async function open() {
  root = createRoot();
  const r = root;
  await act(async () => r.render(React.createElement(Screen)));
  return r;
}
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

/** Ask, and keep the answer once there is one. */
async function ask(r: Root, canOpen: boolean, note?: string) {
  const answer: { pick?: FileChoice | null } = {};
  await act(async () => {
    void choose!({ name: 'inspector-report.pdf', canOpen, ...(note ? { note } : {}) }).then((pick) => {
      answer.pick = pick;
    });
  });
  expect(byId(r, 'file-choice')).not.toHaveLength(0);
  return answer;
}

it('shows nothing until a file is made', async () => {
  const r = await open();
  expect(byId(r, 'file-choice')).toHaveLength(0);
});

it('names the file and offers all three ways when an app on the phone opens it', async () => {
  const r = await open();
  const answer = await ask(r, true);
  expect(shown(r)).toContain('inspector-report.pdf');
  for (const id of ['file-open', 'file-save', 'file-share']) expect(byId(r, id)).not.toHaveLength(0);
  expect(shown(r)).toContain('Open on this phone');
  expect(shown(r)).toContain('Save to phone');
  expect(shown(r)).toContain('Send to another app');
  // Android 11 and later turn down Download itself: the sheet says to pick or make a folder, not "Downloads".
  expect(shown(r)).toMatch(/make a folder/i);

  await tap(r, 'file-open');
  expect(answer.pick).toBe('open');
  expect(byId(r, 'file-choice')).toHaveLength(0);
});

it('leaves Open on this phone out when no app on the phone opens it', async () => {
  const r = await open();
  const answer = await ask(r, false);
  expect(byId(r, 'file-open')).toHaveLength(0);
  await tap(r, 'file-save');
  expect(answer.pick).toBe('save');
});

it('sends it to the share sheet from Send to another app', async () => {
  const r = await open();
  const answer = await ask(r, true);
  await tap(r, 'file-share');
  expect(answer.pick).toBe('share');
});

it('says what went wrong the last time', async () => {
  const r = await open();
  await ask(r, false, 'It could not be saved in that folder. Pick another folder, or make a new one.');
  expect(shown(r)).toContain('It could not be saved in that folder.');
});

it('sends it nowhere when the sheet is closed', async () => {
  const r = await open();
  const answer = await ask(r, true);
  await tap(r, 'sheet-close');
  expect(answer.pick).toBeNull();
  expect(byId(r, 'file-choice')).toHaveLength(0);
});

it('sends it nowhere when the screen goes away with the sheet up', async () => {
  const r = await open();
  const answer = await ask(r, true);
  root = null;
  await act(async () => r.unmount());
  expect(answer.pick).toBeNull();
});

it('lets an earlier ask go when a second file is made', async () => {
  const r = await open();
  const first = await ask(r, true);
  const second = await ask(r, true);
  expect(first.pick).toBeNull();
  await tap(r, 'file-save');
  expect(second.pick).toBe('save');
});
