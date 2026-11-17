import { DELETED, fitsServer, revOf, stableJson, type Change, type SyncKind } from '@app/domain/sync';

import { accessOpens, type BillingView } from './billing';
import type { RecordRow } from './server';

/**
 * What the dashboard writes to the company's records: a unit in the fleet, an
 * area sheet and the shared company settings. It writes them the way a
 * supervisor's phone sends them, through the server's `push_records`: the same
 * record, the same version (`revOf`, a hash of the record) and, as `base`, the
 * version this page loaded, so the server can tell an edit from a copy.
 *
 * Before a record that is already on the server is changed, it is read again.
 * If a phone has sent a newer version since the page loaded, nothing is
 * written: the page says what changed and shows the newer version, for the
 * supervisor to look at again.
 */

/** The kinds of record the dashboard writes. */
export type WrittenKind = Extract<SyncKind, 'equipment' | 'areaSheet' | 'settings'>;

export const keyOf = (kind: string, id: string) => `${kind}:${id}`;

/** The row this page holds for a record, taken off or not: the latest, should it hold two. */
export function loadedRow(rows: readonly RecordRow[], kind: string, id: string): RecordRow | undefined {
  let found: RecordRow | undefined;
  for (const row of rows) {
    if (row.kind !== kind || row.id !== id) continue;
    if (!found || Date.parse(row.updated_at) >= Date.parse(found.updated_at)) found = row;
  }
  return found;
}

/** A record as it is sent: its version worked out as the app does, from the version this page loaded. */
export function saveChange(kind: WrittenKind, id: string, record: object, loaded?: RecordRow): Change {
  return { key: keyOf(kind, id), kind, id, rev: revOf(record), ...(loaded ? { base: loaded.rev } : null), record };
}

/** A record taken off: the server keeps its row, marked deleted, and every version it ever had. */
export function removeChange(kind: WrittenKind, id: string, loaded: RecordRow): Change {
  return { key: keyOf(kind, id), kind, id, rev: DELETED, base: loaded.rev, record: null };
}

// ---- Changed since the page loaded it ------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** What each field of a record is called on the page. */
const FIELD_WORDS: Record<WrittenKind, Record<string, string>> = {
  equipment: {
    unit: 'unit number', category: 'type', make: 'make', model: 'model', status: 'status', meter: 'last reading', meterUnit: 'hours or miles',
  },
  areaSheet: { title: 'name', rows: 'lines', active: 'whether it is in use', single: 'columns' },
  settings: { site: 'clock-in site', workweekStartsOn: 'workweek', allowSectionAllOk: '“Rest are OK” switch' },
};

const COMPANY_WORDS: Record<string, string> = {
  name: 'company name', state: 'state', place: 'place', mineId: 'mine ID', logo: 'logo', pay: 'pay schedule', timeClock: 'time clock', payCodes: 'earning codes',
};

const differs = (a: unknown, b: unknown) => stableJson(a ?? null) !== stableJson(b ?? null);

/** The fields of a record that are not the same in two versions of it, by the name the page gives them. */
export function whatChanged(kind: string, before: unknown, after: unknown): string[] {
  const [was, now] = [obj(before), obj(after)];
  const words = FIELD_WORDS[kind as WrittenKind] ?? {};
  const out: string[] = [];
  for (const field of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    if (field === 'id' || !differs(was[field], now[field])) continue;
    if (kind === 'settings' && field === 'company') {
      const [a, b] = [obj(was.company), obj(now.company)];
      for (const part of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (differs(a[part], b[part])) out.push(COMPANY_WORDS[part] ?? part);
      }
      continue;
    }
    out.push(words[field] ?? field);
  }
  return out;
}

export type Since =
  | { changed: false }
  | {
      changed: true;
      /**
       * `edited`: a newer version. `taken_off`: deleted on the server. `put_back`: it was off and is back.
       * `new_there`: the server has a record under this id that the page never loaded.
       * `hidden`: the page had it and the server no longer shows it to this account.
       */
      how: 'edited' | 'taken_off' | 'put_back' | 'new_there' | 'hidden';
      fields: string[];
    };

/**
 * Whether the record on the server is still the version this page loaded.
 * `loaded` is the row the page holds (none for a new record), `fresh` what the
 * server has now (null when it shows none to this account).
 */
export function changedSince(loaded: RecordRow | undefined, fresh: RecordRow | null): Since {
  if (!loaded) return fresh ? { changed: true, how: 'new_there', fields: [] } : { changed: false };
  if (!fresh) return { changed: true, how: 'hidden', fields: [] };
  if (fresh.rev === loaded.rev && fresh.deleted === loaded.deleted) return { changed: false };
  if (fresh.deleted && !loaded.deleted) return { changed: true, how: 'taken_off', fields: [] };
  if (!fresh.deleted && loaded.deleted) return { changed: true, how: 'put_back', fields: [] };
  return { changed: true, how: 'edited', fields: whatChanged(loaded.kind, loaded.data, fresh.data) };
}

const listed = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How a record is spoken of in a sentence, beside its name. */
export interface Saying {
  /** Its name is a plural: "the company settings" were changed, not was. */
  plural?: boolean;
  /** What the save was doing to it: adding it, changing it, or taking it off. */
  doing?: 'add' | 'change' | 'remove';
}

/** The small words that follow a name: was or were, it or them. */
const words = (say: Saying = {}) =>
  say.plural ? { was: 'were', is: 'are', it: 'them', they: 'they', its: 'the', holds: 'hold' } : { was: 'was', is: 'is', it: 'it', they: 'it', its: 'its', holds: 'holds' };

/** What to tell the supervisor when the record changed under them. `what` names it: "unit L-16", "the Wash bay sheet". */
export function sinceWords(since: Since & { changed: true }, what: string, say?: Saying): string {
  const NOTHING = 'Nothing was saved.';
  const w = words(say);
  switch (since.how) {
    case 'edited': {
      const fields = since.fields.length ? `: ${w.its} ${listed(since.fields)} changed` : '';
      return `${cap(what)} ${w.was} changed on a phone after this page loaded ${w.it}${fields}. ${NOTHING} The page now shows the newer version. Look at ${w.it} again, then save if the change is still wanted.`;
    }
    case 'taken_off':
      return `${cap(what)} ${w.was} taken off after this page loaded ${w.it}. ${NOTHING} The page now shows ${w.it} as ${w.they} ${w.is} on the server.`;
    case 'put_back':
      return `${cap(what)} ${w.was} put back after this page loaded ${w.it}. ${NOTHING} The page now shows ${w.it} as ${w.they} ${w.is} on the server. Look at ${w.it} again.`;
    case 'new_there':
      return `The server already has ${what}: ${w.they} ${w.was} sent after this page loaded. ${NOTHING} The page now shows what the server has. Look at ${w.it}, and change ${w.it} there if ${w.they} ${say?.plural ? 'need' : 'needs'} changing.`;
    case 'hidden':
      return `The server no longer shows ${what} to this account. ${NOTHING} That happens when the company’s MineMuster subscription has stopped, or when this account is no longer a supervisor. Open Billing, or sign out and back in.`;
  }
}

/**
 * Said when the server answered that it took a change and still holds another
 * version. `kept` is true when it holds the version it had before the save:
 * it took the change for one it had been sent already. Otherwise another
 * version arrived in the same moment, and the server has that one.
 */
export function notKeptWords(what: string, kept: boolean, say?: Saying): string {
  const w = words(say);
  const look = `The page shows what the server has. Look at ${w.it} again, then save if the change is still wanted.`;
  return kept
    ? `The server did not keep the change to ${what}: it still has the version it had before. Nothing was saved. ${look}`
    : `Another version of ${what} arrived at the same moment as this save, and the server has that one now. ${look}`;
}

/**
 * What a form holds once the record under it has a newer version. A field
 * nobody touched takes the newer value, so a save after looking again does not
 * put the old one back; a field that was typed in stays as typed. `opened` is
 * what the form started from, `typed` what it holds now, `newer` what the
 * newer version says.
 */
export function followNewer<T extends object>(opened: T, typed: T, newer: T): T {
  const out = { ...typed };
  for (const key of Object.keys(newer) as (keyof T)[]) {
    if (!differs(typed[key], opened[key])) out[key] = newer[key];
  }
  return out;
}

// ---- The server's answer ---------------------------------------------------------------------------

export type Outcome =
  | { ok: true; /** Written over a version this page had not seen, in the moment between the check and the save. */ conflict: boolean }
  | { ok: false; /** The server's reason, or `unknown` when its answer does not name the change. */ reason: string; /** Left for later, not turned down. */ later: boolean; words: string };

interface Entry {
  key?: unknown;
  rev?: unknown;
  reason?: unknown;
  problem?: unknown;
  conflict?: unknown;
}

const entries = (list: unknown): Entry[] => (Array.isArray(list) ? (list.filter((e) => e && typeof e === 'object') as Entry[]) : []);

/** The dashboard takes only a unit off, and a unit is taken out of the fleet. */
const DOING: Record<NonNullable<Saying['doing']>, string> = { add: 'add', change: 'change', remove: 'take out' };

/** Why the server set a change aside, in plain words, and what to do next. */
export function refusalWords(reason: string, what: string, problem?: string, say?: Saying): string {
  const NOTHING = 'Nothing was saved.';
  const w = words(say);
  switch (reason) {
    case 'supervisor_only':
      return `Only a supervisor of the company can ${DOING[say?.doing ?? 'change']} ${what}, and the server says this account is not one now. ${NOTHING} Sign out and back in if your role changed, or ask another supervisor.`;
    case 'private':
      return `The server will not keep ${what} as ${w.they} ${w.was} sent: ${w.they} ${w.holds} something that never leaves a phone, such as a pay rate, or a setting the company does not share. ${NOTHING} Reload the page and try again.`;
    case 'copy':
    case 'taken':
      return `The server already has ${what} under the same id, sent by a phone before this page saw ${w.it}. ${NOTHING} Load new records and look at what is there.`;
    case 'superseded':
      return `Someone else changed ${what} since this page loaded ${w.it}. ${NOTHING} Load new records and look again.`;
    case 'deleted':
      return `${cap(what)} ${w.was} taken off on the server, and only a supervisor puts ${w.it} back. ${NOTHING} Sign out and back in if your role changed.`;
    case 'too_large':
      return `${cap(what)} ${w.is} too large for the server to keep (256 KB at most). ${NOTHING} Shorten ${w.it} and save again.`;
    case 'daily_limit':
      return `This account has sent as much as the server takes from one account in a day. ${NOTHING} Save again tomorrow.`;
    case 'call_size':
      return `The server took too much in one call to take ${what} as well. ${NOTHING} Save again.`;
    case 'unknown':
      return `The server did not say whether ${what} ${w.was} saved. Load new records to see what it has.`;
    default:
      // malformed, unknown_kind, duplicate, and anything a newer server may say.
      return `The server could not take ${what}${problem ? ` (it said: ${problem.replace(/[.\s]+$/, '')})` : ` (reason: ${reason.replace(/_/g, ' ')})`}. ${NOTHING} Reload the page and try again. If it keeps happening, tell whoever runs MineMuster for your company.`;
  }
}

/** What `push_records` said about one change: taken, set aside (and why), or left for later. */
export function readAnswer(answer: unknown, change: Pick<Change, 'key' | 'rev'>, what: string, say?: Saying): Outcome {
  const said = obj(Array.isArray(answer) ? answer[0] : answer);
  const mine = (e: Entry) => e.key === change.key && e.rev === change.rev;
  const took = entries(said.accepted).find(mine);
  if (took) return { ok: true, conflict: took.conflict === true };
  const aside = entries(said.ignored).find(mine);
  const waits = aside ? undefined : entries(said.deferred).find(mine);
  const entry = aside ?? waits;
  const reason = entry && typeof entry.reason === 'string' && entry.reason ? entry.reason : 'unknown';
  return { ok: false, reason, later: !!waits, words: refusalWords(reason, what, entry && typeof entry.problem === 'string' ? entry.problem : undefined, say) };
}

/** Said after a save that went over a version this page had not seen. */
export const CONFLICT_WORDS = 'A phone sent a newer version at the same moment, and this save went over it. Look at it again to be sure it is right.';

// ---- The billing gate ------------------------------------------------------------------------------

/**
 * Why nothing can be saved for want of billing, or null when the company is
 * in. The server takes a record whatever billing says, so that a phone never
 * loses one; the dashboard's own pages, these included, are for a company that
 * has MineMuster.
 */
export function billingRefusal(view: BillingView): string | null {
  if (view.kind !== 'known' || accessOpens(view.billing.access)) return null;
  return view.billing.access === 'ended'
    ? 'Nothing was saved: the company’s MineMuster subscription has ended. Open Billing to start it again.'
    : 'Nothing was saved: the company has no MineMuster trial or subscription yet. Open Billing to start the free trial.';
}

// ---- Saving one record -----------------------------------------------------------------------------

export interface SaveDeps {
  /** The record as the server has it now, or null when it shows none to this account. */
  read: (kind: string, id: string) => Promise<RecordRow | null>;
  /** `push_records`, answering with what the server said. */
  push: (changes: Change[]) => Promise<unknown>;
  /** The signed-in account. */
  me: string;
  now: () => number;
}

export interface Want {
  kind: WrittenKind;
  id: string;
  /** The record to save, or null to take it off. */
  record: object | null;
  /** The row this page holds for it, when it holds one. */
  loaded?: RecordRow;
  /** What to call it in a sentence: "unit L-16", "the Wash bay sheet", "the company settings". */
  what: string;
  /** Its name is a plural, as "the company settings" is. */
  plural?: boolean;
}

export type Saved =
  | { ok: true; row: RecordRow; conflict: boolean; /** The server already had exactly this: nothing was sent. */ same: boolean }
  | { ok: false; why: 'changed'; how: (Since & { changed: true })['how']; fresh: RecordRow | null; words: string }
  /** The server answered that it took the change, and holds another version: `fresh` is what it has. */
  | { ok: false; why: 'not_kept'; fresh: RecordRow; words: string }
  | { ok: false; why: 'refused' | 'later' | 'unknown' | 'too_large'; reason: string; words: string };

/** The row the page holds once the server has taken a change, until the next load reads the server's own. */
export function rowAfter(change: Change, loaded: RecordRow | undefined, by: string, at: number): RecordRow {
  const iso = new Date(at).toISOString();
  return {
    kind: change.kind,
    id: change.id,
    rev: change.rev,
    data: change.record ?? {},
    deleted: change.rev === DELETED,
    created_by: loaded ? loaded.created_by : by,
    updated_by: by,
    created_at: loaded?.created_at ?? iso,
    updated_at: iso,
  };
}

/**
 * The same change, sent so that the server cannot take it for one it was sent
 * already. The server writes nothing when a change has the version and the
 * base of the caller's own latest change to the record: its rule for a batch
 * sent again after a lost answer. Versions are hashes of the record, so a real
 * second change matches too once someone else has put the record back in
 * between (stopped, started again by another supervisor, stopped again). This
 * one names its own version as its base: the last version of the record the
 * server confirmed to this account with these very contents.
 */
export function sentAgain(change: Change): Change {
  return { ...change, base: change.rev };
}

/**
 * Save one record, or take one off.
 *
 *  1. The record is read again. A version this page has not seen stops the
 *     save; a version that is already exactly what is being saved (an earlier
 *     press whose answer was lost) is the save, done.
 *  2. The change goes to `push_records`, and a refusal is put into words.
 *  3. The record is read once more, because "accepted" does not always mean
 *     written (`sentAgain`). When the server still holds the version it held
 *     before, the change is sent once more in a form it will write. Only a
 *     version the server shows is handed back as saved; anything else is said
 *     as it is, with the server's row for the page.
 *
 * Errors from the server itself (no connection, signed out) are thrown by
 * `read` and `push`. Should only the last read fail, the save went through as
 * far as the server said, and the page shows what was sent.
 */
export async function saveRecord(deps: SaveDeps, want: Want): Promise<Saved> {
  const { kind, id, record, loaded, what } = want;
  const say: Saying = { plural: want.plural, doing: !record ? 'remove' : loaded && !loaded.deleted ? 'change' : 'add' };
  const fresh = await deps.read(kind, id);
  // The server has exactly this already: a press before this one went through, and its answer was lost.
  if (fresh && (record ? !fresh.deleted && fresh.rev === revOf(record) : fresh.deleted && !!loaded && !loaded.deleted)) {
    return { ok: true, row: fresh, conflict: false, same: true };
  }
  const since = changedSince(loaded, fresh);
  if (since.changed) return { ok: false, why: 'changed', how: since.how, fresh, words: sinceWords(since, what, say) };

  if (!record && (!loaded || loaded.deleted)) {
    // Nothing on the server to take off.
    return { ok: true, row: loaded ?? rowAfter({ key: keyOf(kind, id), kind, id, rev: DELETED, record: null }, undefined, deps.me, deps.now()), conflict: false, same: true };
  }
  const change = record ? saveChange(kind, id, record, loaded) : removeChange(kind, id, loaded!);
  if (!fitsServer(change)) return { ok: false, why: 'too_large', reason: 'too_large', words: refusalWords('too_large', what, undefined, say) };

  const refused = (outcome: Outcome & { ok: false }): Saved => ({
    ok: false, why: outcome.reason === 'unknown' ? 'unknown' : outcome.later ? 'later' : 'refused', reason: outcome.reason, words: outcome.words,
  });
  const outcome = readAnswer(await deps.push([change]), change, what, say);
  if (!outcome.ok) return refused(outcome);

  // What the page shows when the server cannot be read after it answered: what was sent.
  const asSent = (conflict: boolean): Saved => ({ ok: true, row: rowAfter(change, loaded, deps.me, deps.now()), conflict, same: false });
  let stored: RecordRow | null;
  try {
    stored = await deps.read(kind, id);
  } catch {
    return asSent(outcome.conflict);
  }
  if (stored && stored.rev === change.rev) return { ok: true, row: stored, conflict: outcome.conflict, same: false };

  // Accepted, and the server holds the version it held before: it took the change for one sent already.
  const kept = !!stored && !!fresh && stored.rev === fresh.rev && !outcome.conflict;
  if (kept) {
    const again = sentAgain(change);
    const second = readAnswer(await deps.push([again]), again, what, say);
    if (!second.ok) return refused(second);
    try {
      stored = await deps.read(kind, id);
    } catch {
      return asSent(false);
    }
    // Written this time. The server calls it a conflict because of the base it was sent with; it is not one.
    if (stored && stored.rev === change.rev) return { ok: true, row: stored, conflict: false, same: false };
  }
  if (!stored) return { ok: false, why: 'unknown', reason: 'unknown', words: refusalWords('unknown', what, undefined, say) };
  return { ok: false, why: 'not_kept', fresh: stored, words: notKeptWords(what, !!fresh && stored.rev === fresh.rev, say) };
}
