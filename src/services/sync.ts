import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { changesToSend, retryDelay, sendWaiting, type SyncStatus, type SyncTransport } from '../domain/sync';
import { SAMPLE_CREW_IDS } from '../store/seed';
import { HOLDS_SAMPLES, useStore, type Store } from '../store/useStore';

/**
 * Keeps the company's server up to date from this phone.
 *
 * Every punch, checklist, exam and request is saved on the phone the moment it
 * is signed, signal or not. This watches for signal and, when the build has a
 * company server, sends what the server does not have yet: when signal comes
 * back, when the app is opened, and a few seconds after anything is signed.
 * A round that does not get through is tried again, waiting longer each time.
 *
 * A phone that holds the made-up sample crew sends nothing at all: their
 * history has touched the fleet, the sheets and other people's records, so
 * none of it can be told apart from the company's own.
 */

export type { SyncStatus };

export const useSyncStatus = create<SyncStatus>(() => ({
  online: true,
  server: false,
  waiting: 0,
  sending: false,
  lastSentAt: null,
  failed: false,
}));

/** No server is connected yet: records stay on the phone. The server step sets one. */
let transport: SyncTransport | null = null;

export function setSyncTransport(next: SyncTransport | null): void {
  transport = HOLDS_SAMPLES ? null : next;
  useSyncStatus.setState({ server: !!transport });
  if (transport) void syncNow();
}

/**
 * Connected, unless the phone says it is not. Only the connection counts: on
 * Android "internet reachable" reads false for a moment after every change of
 * network, and a send that cannot get through is simply tried again.
 */
const isOnline = (state: NetworkState) => state.isConnected !== false;

const waitingNow = () => {
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

async function round(): Promise<void> {
  if (!transport || stopped) return;
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  const changes = waitingNow();
  useSyncStatus.setState({ waiting: changes.length });
  if (!changes.length || !useSyncStatus.getState().online) return;
  useSyncStatus.setState({ sending: true });
  let failed = true;
  let sent = 0;
  try {
    const result = await sendWaiting(changes, transport, (accepted) => useStore.getState().markSynced(accepted));
    failed = result.failed;
    sent = result.sent;
  } finally {
    if (failed) {
      failures += 1;
      // The wait before the next try holds even if more was signed meanwhile.
      again = false;
      if (!stopped) retry = setTimeout(() => void syncNow(), retryDelay(failures));
    } else {
      failures = 0;
    }
    useSyncStatus.setState({
      sending: false,
      failed,
      waiting: waitingNow().length,
      ...(sent ? { lastSentAt: Date.now() } : null),
    });
  }
}

/** The parts of the store that are sent: when one of them changes, there is something new to send. */
const SENT_PARTS = ['employees', 'equipment', 'areaSheets', 'shifts', 'denied', 'leave', 'inspections', 'opLogs', 'exams', 'mrfs', 'settings'] as const;
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
    if (!transport || !changed(now, before)) return;
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
    network.remove();
    unsubscribe();
    app.remove();
    if (soon) clearTimeout(soon);
    if (retry) clearTimeout(retry);
    retry = null;
  };
}
