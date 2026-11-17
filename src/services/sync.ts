import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { CAN_SEND } from '../config';
import { changesToSend, retryDelay, sendWaiting, type Change, type SendTrouble, type SyncStatus, type SyncTransport } from '../domain/sync';
import { SAMPLE_CREW_IDS } from '../store/seed';
import { useStore, type Store } from '../store/useStore';

/**
 * Keeps the company's server up to date from this phone.
 *
 * Every punch, checklist, exam and request is saved on the phone the moment it
 * is signed, signal or not. This watches for signal and, when the phone is
 * connected to its company, sends what the server does not have yet: when
 * signal comes back, when the app is opened, and a few seconds after anything
 * is signed. A round that does not get through is tried again, waiting longer
 * each time.
 *
 * A preview build sends nothing at all, and nor does one that holds the
 * made-up sample crew (`CAN_SEND`): their history has touched the fleet, the
 * sheets and other people's records, so none of it can be told apart from the
 * company's own.
 */

export type { SyncStatus };

export const useSyncStatus = create<SyncStatus>(() => ({
  online: true,
  server: false,
  waiting: 0,
  sending: false,
  lastSentAt: null,
  failed: false,
  trouble: null,
  problem: null,
  stuck: 0,
}));

/** Where records go: none until the phone is connected to its company (`watchConnection` in `connection.ts`), and they stay on the phone. */
let transport: SyncTransport | null = null;
/**
 * Why a phone that is connected to its company is not sending now: its account
 * is signed out or not on the company's roster, or the account is still being
 * checked against the roster.
 */
let held: SendTrouble | 'checking' | null = null;
/** Stops the call under way when the transport changes. */
let inFlight: AbortController | null = null;
/** Changes the server would not take, at the version it turned down: not sent again until they change. */
const stuck = new Map<string, string>();

/**
 * Send to this transport from now on, or to none. `why` says why a phone that
 * is connected is not sending (its account is signed out, say), so the records
 * row can tell the person what to do. A round still on its way to the old
 * transport stops at once: the call under way is aborted, nothing more goes,
 * and no answer from it is noted.
 */
export function setSyncTransport(next: SyncTransport | null, why: SendTrouble | 'checking' | null = null): void {
  const allowed = CAN_SEND ? next : null;
  if (allowed !== transport) {
    inFlight?.abort();
    inFlight = null;
    stuck.clear();
  }
  transport = allowed;
  held = CAN_SEND && !allowed ? why : null;
  const connected = !!transport || !!held;
  useSyncStatus.setState({
    server: connected,
    trouble: held === 'checking' ? null : held,
    problem: null,
    failed: false,
    sending: false,
    waiting: connected ? waitingNow().length : 0,
  });
  if (transport) void syncNow();
}

/**
 * Connected, unless the phone says it is not. Only the connection counts: on
 * Android "internet reachable" reads false for a moment after every change of
 * network, and a send that cannot get through is simply tried again.
 */
const isOnline = (state: NetworkState) => state.isConnected !== false;

const waitingNow = (): Change[] => {
  const state = useStore.getState();
  return changesToSend(state, state.synced, SAMPLE_CREW_IDS);
};

let running: Promise<void> | null = null;
let again = false;
let failures = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

/** Send what is waiting now. A call while a round is running starts one more round after it. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = round()
    .catch(() => undefined)
    .finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        void syncNow();
      }
    });
  return running;
}

/** Wait for the round under way, if any, to end. */
export function syncSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

async function round(): Promise<void> {
  const target = transport;
  if (!target || stopped) return;
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  const company = useStore.getState().syncedWith;
  const all = waitingNow();
  useSyncStatus.setState({ waiting: all.length });
  const changes = all.filter((c) => stuck.get(c.key) !== c.rev);
  if (!changes.length || !useSyncStatus.getState().online) return;
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  inFlight = abort;
  // Only while the phone still sends to the same company through the same link: after a
  // disconnect, or a move to another company, nothing more goes and no late answer is noted.
  const current = () => transport === target && !stopped && useStore.getState().syncedWith === company;
  useSyncStatus.setState({ sending: true });
  let failed = true;
  let trouble: SendTrouble | null = 'unreachable';
  let problem: string | null = null;
  let sent = 0;
  try {
    const result = await sendWaiting(changes, target, (accepted) => useStore.getState().markSynced(accepted, company), {
      still: current,
      signal: abort?.signal,
    });
    if (result.stopped || !current()) return;
    for (const change of result.stuck) stuck.set(change.key, change.rev);
    ({ failed, trouble, problem, sent } = result);
  } finally {
    if (inFlight === abort) inFlight = null;
    if (current()) {
      // Signed out, or off the roster: trying again changes nothing until someone puts it right,
      // and the phone tries again by itself once they have (signed in, or the app opened again).
      const waits = failed && trouble !== 'signed_out' && trouble !== 'not_member';
      if (failed) failures += 1;
      else failures = 0;
      if (waits) {
        // The wait before the next try holds even if more was signed meanwhile.
        again = false;
        retry = setTimeout(() => void syncNow(), retryDelay(failures));
      }
      useSyncStatus.setState({
        sending: false,
        failed,
        trouble: failed ? trouble : null,
        problem: failed ? problem : null,
        stuck: stuck.size,
        waiting: waitingNow().length,
        ...(sent ? { lastSentAt: Date.now() } : null),
      });
    }
  }
}

/** The parts of the store that are sent: when one of them changes, there is something new to send. */
const SENT_PARTS = ['employees', 'equipment', 'areaSheets', 'shifts', 'denied', 'leave', 'inspections', 'opLogs', 'exams', 'mrfs', 'settings', 'synced'] as const;
const changed = (a: Store, b: Store) => SENT_PARTS.some((k) => a[k] !== b[k]);

/** Start watching for signal and for new records. Returns a function that stops it. */
export function startSync(): () => void {
  stopped = false;
  let heard = false;
  const setOnline = (state: NetworkState) => {
    const online = isOnline(state);
    const was = useSyncStatus.getState().online;
    useSyncStatus.setState({ online });
    if (online && !was) void syncNow();
  };
  // The first reading can come back after a change was already heard; then it is out of date.
  getNetworkStateAsync().then((state) => {
    if (!heard) setOnline(state);
  }, () => undefined);
  const network = addNetworkStateListener((state) => {
    heard = true;
    setOnline(state);
  });

  let soon: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useStore.subscribe((now, before) => {
    if (!(transport || held) || !changed(now, before)) return;
    // The count is right the moment something is signed, so the phone never says everything is
    // sent while a new punch waits. The send itself waits a few seconds, for anything signed with it.
    const status = useSyncStatus.getState();
    if (!status.sending) useSyncStatus.setState({ waiting: waitingNow().length });
    if (!transport || now.synced !== before.synced) return;
    if (soon) clearTimeout(soon);
    soon = setTimeout(() => void syncNow(), 3_000);
  });
  const app = AppState.addEventListener('change', (state) => {
    if (state === 'active') void syncNow();
  });
  void syncNow();

  return () => {
    stopped = true;
    again = false;
    inFlight?.abort();
    inFlight = null;
    network.remove();
    unsubscribe();
    app.remove();
    if (soon) clearTimeout(soon);
    if (retry) clearTimeout(retry);
    retry = null;
  };
}
