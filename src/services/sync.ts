import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { CAN_SEND } from '../config';
import { checkCompany } from '../domain/company';
import {
  callWithin,
  retryDelay,
  SEND_TIMEOUT_MS,
  sendWaiting,
  sortedChanges,
  timedOut,
  troubleOf,
  type Change,
  type SendResult,
  type SendTrouble,
  type SortedChanges,
  type SyncStatus,
  type SyncTransport,
} from '../domain/sync';
import { SAMPLE_CREW_IDS } from '../store/seed';
import { useStore, type ReceiveContext, type Store } from '../store/useStore';

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
 *
 * A round, one at a time and never in the background:
 *  1. Send what was made here: shifts, turned-down punches, leave,
 *     checklists, end of use, exams and requests, with ahead of them a unit or
 *     a sheet this phone added. A punch never waits behind a read.
 *  2. Ask who this phone's company sign-in is to the company: its own row of
 *     the roster. Not on it ends the round.
 *  3. Read the company's settings, roster, fleet and area sheets after the
 *     phone's cursor, page by page, to an empty page or a minute.
 *  4. Send the phone's changes of those four kinds, made from the versions
 *     just read. One the server holds a newer version of sends steps 3 and 4
 *     again, at most twice.
 * A transport that cannot read (a test's, an older one) only sends.
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
  notTaken: 0,
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

/** What the phone has to send, sorted for a phone connected to its company (`sortedChanges`). */
const sortedNow = (): SortedChanges => {
  const state = useStore.getState();
  const r = state.receiving;
  // A phone connected to its company sorts what it sends the same way whether or not it can reach the server now.
  const here = state.connectedCompany
    ? { connected: true, role: r?.role ?? null, caughtUp: r?.caughtUpAt != null, unreadable: r?.unreadable ?? [], held: r?.held ?? {} }
    : undefined;
  return sortedChanges(state, state.synced, SAMPLE_CREW_IDS, here);
};
const waitingNow = (): Change[] => {
  const sorted = sortedNow();
  return [...sorted.now, ...sorted.afterReceive];
};
/** What the company would not take from this sign-in: held at the version refused, or passed over for its role. */
export const notTakenChanges = (): Change[] => sortedNow().notTaken;
const notTakenNow = (): number => notTakenChanges().length;

/** How long a round reads the company's records before it lets the next round carry on. */
export const RECEIVE_BUDGET_MS = 60_000;
/** A page answered quicker than this doubles the next page's size, up to 500 rows. */
const QUICK_PAGE_MS = 5_000;
/** Every five minutes while the app is open and in front, a round reads what the company changed. */
export const RECEIVE_EVERY_MS = 5 * 60_000;

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
  const store = useStore.getState;
  const company = store().syncedWith;
  const account = store().connectedCompany?.userId ?? null;
  const receives = !!(target.pull && target.standing && store().connectedCompany);
  if (receives) store().ensureReceiving();
  useSyncStatus.setState({ waiting: waitingNow().length, notTaken: notTakenNow() });
  if (!useSyncStatus.getState().online) return;
  const first = sortedNow().now.filter((c) => stuck.get(c.key) !== c.rev);
  if (!receives && !first.length) return;
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  inFlight = abort;
  // Only while the phone still sends to the same company through the same link: after a
  // disconnect, or a move to another company, nothing more goes and no late answer is noted.
  const current = () => transport === target && !stopped && store().syncedWith === company;
  useSyncStatus.setState({ sending: true });
  let failed = false;
  let trouble: SendTrouble | null = null;
  let problem: string | null = null;
  let sent = 0;
  const fail = (error: unknown) => {
    failed = true;
    trouble = troubleOf(error);
    problem = error instanceof Error && trouble !== 'unreachable' ? error.message : null;
  };
  /** Sends these, noting what became of each. */
  const send = async (changes: readonly Change[]): Promise<SendResult & { stale: boolean }> => {
    if (company) store().markSending(changes, company);
    let stale = false;
    const result = await sendWaiting(
      changes,
      target,
      (answer) => {
        if (!receives) {
          // A transport that cannot read: every answer counts as sent, as it always has.
          const all = [...answer.took, ...answer.stale, ...answer.floored, ...answer.held].map(({ key, rev }) => ({ key, rev }));
          store().markSynced(all, company, changes);
          return;
        }
        store().markSynced(answer.took, company, changes);
        if (company) {
          store().holdRefused(answer.held, company);
          store().keepFloor(answer.floored, company);
        }
        if (answer.stale.length) stale = true;
      },
      { still: current, signal: abort?.signal },
    );
    for (const change of result.stuck) stuck.set(change.key, change.rev);
    sent += result.sent;
    return { ...result, stale };
  };
  const context = (): ReceiveContext | null => {
    const r = store().receiving;
    return r && company && account ? { company, account, epoch: r.epoch } : null;
  };
  try {
    // 1. What was made here.
    let notMember = false;
    if (first.length) {
      const result = await send(first);
      if (result.stopped || !current()) return;
      if (result.failed) {
        if (result.trouble !== 'not_member' || !receives) {
          failed = true;
          ({ trouble, problem } = result);
          return;
        }
        // Read the standing all the same, so the phone knows for certain.
        notMember = true;
      }
    }
    if (!receives) return;

    // 2. Who this phone's sign-in is to the company.
    const standing = await callWithin((signal) => target.standing!(signal), SEND_TIMEOUT_MS, abort?.signal);
    if (!current()) return;
    const ctx = context();
    if (!ctx) return;
    store().applyStanding(ctx, standing);
    if (!standing) {
      failed = true;
      trouble = 'not_member';
      problem = 'This phone’s company sign-in is not on the company’s roster any more.';
      return;
    }
    if (notMember) {
      // On the roster after all: the send is tried again in the next round.
      failed = true;
      trouble = 'unreachable';
    }

    // 3 and 4, again at most twice when the server holds newer versions than the phone sent from.
    for (let pass = 0; pass < 3; pass += 1) {
      const caughtUp = await receive(target, company!, account!, current, abort?.signal);
      if (!caughtUp || !current()) return;
      const rest = sortedNow().afterReceive.filter((c) => stuck.get(c.key) !== c.rev);
      if (!rest.length) return;
      const result = await send(rest);
      if (result.stopped || !current()) return;
      if (result.failed) {
        failed = true;
        ({ trouble, problem } = result);
        return;
      }
      if (!result.stale) return;
    }
  } catch (error) {
    if (!current()) return;
    fail(error);
  } finally {
    if (inFlight === abort) inFlight = null;
    if (current()) {
      // Signed out, off the roster, or MineMuster stopped for the company: trying again changes
      // nothing until someone puts it right, and the phone tries again by itself once they have
      // (signed in, the app opened again, the five-minute read, or the button).
      const waits = failed && trouble !== 'signed_out' && trouble !== 'not_member' && trouble !== 'closed';
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
        notTaken: notTakenNow(),
        ...(sent ? { lastSentAt: Date.now() } : null),
      });
    }
  }
}

/**
 * Step 3 of a round: the company's records after the phone's cursor, a page at
 * a time, each merged in one write as it comes. True once a page comes back
 * empty. A page that had no answer in time halves the next page, so a big
 * record on one bar ends as a page of one; a quick page doubles it. A round
 * that spends its minute while pages still come leaves the rest to a round two
 * seconds later.
 */
async function receive(target: SyncTransport, company: string, account: string, current: () => boolean, signal?: AbortSignal): Promise<boolean> {
  const store = useStore.getState;
  const started = Date.now();
  while (Date.now() - started < RECEIVE_BUDGET_MS) {
    const r = store().receiving;
    if (!r) return false;
    const ctx = { company, account, epoch: r.epoch };
    const asked = Date.now();
    let rows;
    try {
      rows = await callWithin((s) => target.pull!(r.cursor, r.pageSize, s), SEND_TIMEOUT_MS, signal);
    } catch (error) {
      if (timedOut(error) && current()) store().setReceivePageSize(ctx, Math.max(1, Math.floor(r.pageSize / 2)));
      throw error;
    }
    if (!current()) return false;
    const neverCaughtUp = store().receiving?.caughtUpAt == null;
    if (!store().applyReceived(ctx, rows)) continue;
    if (Date.now() - asked < QUICK_PAGE_MS && rows.length >= r.pageSize) store().setReceivePageSize(ctx, Math.min(500, r.pageSize * 2));
    if (rows.length) continue;
    // Caught up. A company that never sent its settings: the phone starts from the company's own row.
    const { synced, settings } = store();
    if (neverCaughtUp && target.companyRow && synced['settings:company'] === undefined && checkCompany(settings.company) !== undefined) {
      const row = await callWithin((s) => target.companyRow!(s), SEND_TIMEOUT_MS, signal);
      const now = store().receiving;
      if (row && current() && now) store().takeCompanyRow({ company, account, epoch: now.epoch }, row);
    }
    return true;
  }
  // The minute is spent and pages still come: the next round carries on in two seconds.
  if (current()) {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => void syncNow(), 2_000);
  }
  return false;
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
  // Every five minutes while the app is in front, a round reads what the company changed.
  let every: ReturnType<typeof setInterval> | null = null;
  // In front unless the phone says the app is behind something or in the background ('unknown' at start-up counts as in front).
  const watchFront = (state: string | null | undefined) => {
    const front = state !== 'background' && state !== 'inactive';
    if (front && !every) every = setInterval(() => void syncNow(), RECEIVE_EVERY_MS);
    if (!front && every) {
      clearInterval(every);
      every = null;
    }
  };
  watchFront(AppState.currentState);
  const app = AppState.addEventListener('change', (state) => {
    watchFront(state);
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
    if (every) clearInterval(every);
    if (soon) clearTimeout(soon);
    if (retry) clearTimeout(retry);
    retry = null;
  };
}
