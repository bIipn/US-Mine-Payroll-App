import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type { StateStorage } from 'zustand/middleware';

import { md5 } from '../util/hash';
import {
  afterEvery,
  bootClock,
  copyName,
  copyOf,
  forgottenBefore,
  fromEarlierBoot,
  markerName,
  markerOf,
  newestFirst,
  nextOrder,
  placeName,
  readableAfter,
  settledNewestFirst,
  settlesIn,
  toLetGo,
  type Clocks,
  type Copy,
  type Forgetting,
  type Marker,
  type Named,
  type Start,
} from './recordCopies';
import { guardRecords } from './recordGuard';

/**
 * Device storage on iPhone and Android. storage.ts is the web's, and holds the shared types.
 *
 * The store's records (`recordStorage`) are one value that grows with every punch, checklist, exam and request,
 * and none of it is ever pruned. On Android they are kept in a file of their own, in the app's private files:
 * AsyncStorage keeps a value in one SQLite row, and Android cannot hand back a row over about 2 MB (it must fit
 * one CursorWindow), which a phone's records pass in months. A phone that kept them in AsyncStorage under an
 * older version has them moved into the file the first time they are read; the row stays until a whole copy of the
 * file has had time to reach the disk. On the iPhone they stay in AsyncStorage, where they have
 * always been: it keeps a large value in a file of its own, with no such limit, in a folder left out of the phone's
 * backups, where a file in the app's documents would go into them. When AsyncStorage loses track of that file, the
 * app reads it itself (`readRow`).
 *
 * Nothing is written over the records until the store has read them (`recordsRead`). A save made before then is
 * an empty phone's, and a phone whose records could not be read keeps them where they are; the store says so,
 * instead of opening as a new phone. A save that cannot be written (a full phone) is held in memory and said on
 * every screen until one works (`watchUnsaved`). Both are recordGuard.ts, which the web's storage uses too.
 *
 * On Android a save cannot make what it writes reach the disk before the app goes on (recordCopies.ts), so a
 * power cut can tear what was written in the last half a minute or so. Each save is a copy of its own, named by its
 * place, by when it was written on the steady clock and by the start of the app that wrote it, and older copies go by
 * rules that keep a whole copy that has had time to reach the disk always there; whether one has is judged by the
 * steady clock, never by the phone's own, which can jump. A copy is read only if it is whole JSON. When a newer copy
 * was torn and an older one was read, the store is told (`passedOverNewer`) and the app says so once. When the store
 * empties the phone, or takes one person's account off it, it says so first (`forgetCopies`): after a clear the copies
 * from before go with its save, after a drop as soon as a copy after it has settled; when a power cut undoes a drop,
 * the store is told whose account it was (`undoneDrops`), and makes it again.
 *
 * Everything else, the company server's session among it, stays in AsyncStorage (`safeStorage`). A row there that
 * cannot be read or written falls back to memory for the rest of the session on its own, not every row with it.
 */

/** Whether the records are kept in a file: on Android. */
const IN_FILE = Platform.OS === 'android';

// ---- Everything but the records -----------------------------------------------------------

const memory = new Map<string, string>();
/** Rows the phone could not read or write this session, kept in memory instead. */
const broken = new Set<string>();

export const safeStorage: StateStorage = {
  async getItem(key) {
    if (!broken.has(key)) {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        broken.add(key);
      }
    }
    return memory.get(key) ?? null;
  },
  async setItem(key, value) {
    if (!broken.has(key)) {
      try {
        await AsyncStorage.setItem(key, value);
        return;
      } catch {
        broken.add(key);
      }
    }
    memory.set(key, value);
  },
  async removeItem(key) {
    memory.delete(key);
    if (!broken.has(key)) {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        broken.add(key);
      }
    }
  },
};

// ---- The records, in a file (Android) ------------------------------------------------------

/**
 * The records' files, by name: a copy being written, and the file and the new copy beside it that earlier builds
 * kept, which this one reads and gives names of their own at its first save. Every copy is beside them, each in a
 * file of its own (recordCopies.ts), and so may be the copy before the last that an earlier build kept (`.prev`), and
 * the marks of a clear or a drop.
 */
function namesOf(key: string) {
  return { part: `${key}.json.part`, kept: `${key}.json`, next: `${key}.json.next` };
}

/** A file in the app's files. Made new for each step, since a rename points the File it was asked of at where the file went. */
const at = (name: string) => new File(Paths.document, name);

/** Whether a copy is whole: one torn by a power cut is not JSON. */
function whole(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** When what a file holds was written by the phone's clock (its modificationTime, which a rename keeps), or null when the phone cannot say. */
function writtenAt(name: string): number | null {
  try {
    const info = at(name).info();
    return info.exists && typeof info.modificationTime === 'number' ? info.modificationTime : null;
  } catch {
    return null;
  }
}

/**
 * Both clocks, now. The steady one (performance.now, which React Native's own module reads from
 * std::chrono::steady_clock) is the only one that says a copy has had time to reach the disk; the phone's clock can
 * jump (recordCopies.ts).
 */
const clocksNow = (): Clocks => ({ wall: Date.now(), steady: performance.now() });

/** What this session knows of one copy of the records, by its file's name. It goes where the file goes. */
interface Held {
  /** By the steady clock, when this session wrote the copy, or first saw it. */
  firstSeen: number;
  /** Whether this session wrote it. */
  own: boolean;
  /** Whether this session knows it whole: it wrote it, or read it whole. */
  known: boolean;
}

/** Where the store's records were read from, until the next save or clear has put that in place (`settle`). */
type ReadFrom =
  /** The copy at this place: every one after it is torn. */
  | { copy: number }
  /** Emptied by a clear, with nothing saved since whole: every copy at this place or after it is torn. */
  | { cleared: number }
  /** An older version's row: every copy of the files is torn. */
  | { row: true };

/** What this session keeps about the records of one key. Never saved: a new start knows only what is in the files. */
interface Session {
  held: Map<string, Held>;
  /** The steady clock when this session first read the records, or first saved them (recordCopies.ts, `Start`). */
  startedAt?: number;
  readFrom?: ReadFrom;
  /** Whether the last read passed over a newer copy that was there and was not whole. */
  passedOver: boolean;
  /**
   * The drops the copy the last read took is older than, so that a power cut undid them, and that the store has not
   * made again since (`dropUndone`, `undoneDrops`).
   */
  undone: Marker[];
  /**
   * A clear or a drop the store said is coming whose mark is not on the phone yet: the phone had no room for it. The save
   * that follows makes it (`writeFile`).
   */
  forgetting?: { how: Forgetting; id?: string };
  /**
   * Nothing of the records is on the phone: its first save writes a clear mark first, so that a new phone whose first
   * saves are all torn opens as new, not on Records not read.
   */
  fresh: boolean;
  /** An older version's row is still in AsyncStorage: it goes once a copy of the file has settled (`tidy`). */
  row: boolean;
  /** The store has read the records and saves them: nothing goes before then (`tidy`). */
  storeRead: boolean;
  /** The timer that tidies with the app idle (`schedule`). */
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();
function sessionOf(key: string): Session {
  let session = sessions.get(key);
  if (!session) {
    session = { held: new Map(), passedOver: false, undone: [], fresh: false, row: false, storeRead: false };
    sessions.set(key, session);
  }
  return session;
}

/** This session's start, for the rules: when it first read or saved the records, by the steady clock. */
function startOf(session: Session, steady: number): Start {
  session.startedAt ??= steady;
  return { startedAt: session.startedAt };
}

/** This session has seen a copy. One it has no time for yet was there before: it counts as first seen now. */
function seen(session: Session, name: string, steady: number): Held {
  let held = session.held.get(name);
  if (!held) session.held.set(name, (held = { firstSeen: steady, own: false, known: false }));
  return held;
}

/** A copy went from one name to another: what this session knows of it goes with it. */
function carried(session: Session, from: string, to: string): void {
  const held = session.held.get(from);
  session.held.delete(from);
  if (held) session.held.set(to, held);
  else session.held.delete(to);
}

/** A copy this session no longer has. Throws when the file cannot be deleted. */
function deleted(session: Session, name: string): void {
  at(name).delete();
  session.held.delete(name);
}

interface Listed {
  /** The copies of the key, newest first. */
  copies: Copy[];
  /** The marks of a clear or a drop beside them. */
  markers: Marker[];
}

/**
 * The copies of `key` in the app's files, newest first, and the marks beside them. The file and the new copy beside
 * it that an earlier build kept come after every checkpoint and every mark there, as that build read them. Throws
 * when the files cannot be listed.
 */
function listed(key: string, session: Session, steady: number): Listed {
  const names = namesOf(key);
  const found: { name: string; named: Named }[] = [];
  const markers: Marker[] = [];
  let kept = false;
  let next = false;
  for (const entry of Paths.document.list()) {
    const name = entry.name;
    const marker = markerOf(key, name);
    if (marker) markers.push(marker);
    else if (name === names.kept) kept = true;
    else if (name === names.next) next = true;
    else {
      const named = copyOf(key, name);
      if (named) found.push({ name, named });
    }
  }
  const base = Math.max(1, afterEvery(found.map((f) => f.named)), forgottenBefore(markers));
  if (kept) found.push({ name: names.kept, named: { order: base, steady: null, clock: null } });
  if (next) found.push({ name: names.next, named: { order: base + 1, steady: null, clock: null } });
  const copies = found.map(({ name, named }): Copy => {
    const held = seen(session, name, steady);
    return { ...named, name, wall: writtenAt(name), firstSeen: held.firstSeen, own: held.own, known: held.known };
  });
  return { copies: newestFirst(copies), markers };
}

/** What a read of the files found. */
type Found =
  /** The newest copy that is whole, at this place. */
  | { kind: 'whole'; text: string; order: number; passedOver: boolean; markers: Marker[] }
  /** No copy whole: the newest, as it is. */
  | { kind: 'torn'; text: string; markers: Marker[] }
  /** Emptied by a clear, and nothing saved since is whole. */
  | { kind: 'cleared'; passedOver: boolean }
  | { kind: 'none' };

/**
 * The records in the files: the newest copy that is whole, newest first by place. Never a copy still being written
 * (`.part`), and never one from before a clear (a mark says which): when nothing saved since the clear is whole,
 * `cleared`, and the phone opens as the build starts. A copy that cannot be read at all fails the read: it is not
 * passed over, since what is in it may be the newest. With no copy whole, the newest is handed back as it is, and the
 * store, which cannot read it either, says so.
 */
async function readFile(key: string): Promise<Found> {
  const session = sessionOf(key);
  const { steady } = clocksNow();
  startOf(session, steady);
  const { copies, markers } = listed(key, session, steady);
  const readable = readableAfter(markers);
  let newest: string | null = null;
  for (const copy of copies) {
    if (copy.order < readable) continue;
    const text = await at(copy.name).text();
    if (whole(text)) {
      seen(session, copy.name, steady).known = true;
      session.readFrom = { copy: copy.order };
      return { kind: 'whole', text, order: copy.order, passedOver: newest !== null, markers };
    }
    newest ??= text;
  }
  if (markers.some((m) => m.how === 'clear')) {
    session.readFrom = { cleared: readable };
    return { kind: 'cleared', passedOver: newest !== null };
  }
  return newest === null ? { kind: 'none' } : { kind: 'torn', text: newest, markers };
}

/**
 * Once the store has read the records (`opened`), or before the first save or clear after a read, put what was read in
 * place: take away every copy newer than it, which were torn, so that none is ever taken for a whole copy settled on
 * the disk; the file an earlier build kept when the new copy beside it was read, and any copy that build kept, older
 * than the one read, that is not whole; and when what was read is older than a drop, mark that drop undone, naming the
 * same account (`undoneDrops`), so that nothing saved from now on counts as made after it. Then give the file and the
 * copy beside it that an earlier build kept names of their own, by the places they were read at. Done again until it
 * works.
 */
async function settle(key: string, session: Session): Promise<void> {
  const names = namesOf(key);
  const { steady } = clocksNow();
  let listing = listed(key, session, steady);
  const from = session.readFrom;
  if (from) {
    for (const copy of listing.copies) {
      const torn = 'row' in from || ('copy' in from ? copy.order > from.copy : copy.order >= from.cleared);
      if (torn) deleted(session, copy.name);
    }
    if ('copy' in from) {
      // The file an earlier build kept is older than the new copy beside it, which was read: it goes, as that build's
      // next save would have moved the new copy over it. So does any copy that build kept, older than the one read,
      // that is not whole: it is never of use, and would only take room.
      const read = listing.copies.find((c) => c.order === from.copy);
      for (const copy of listing.copies) {
        if (copy.steady !== null || copy.order >= from.copy) continue;
        if (copy.name === names.kept && read?.name === names.next) {
          deleted(session, copy.name);
          continue;
        }
        let text: string;
        try {
          text = await at(copy.name).text();
        } catch {
          continue;
        }
        if (!whole(text)) deleted(session, copy.name);
      }
      for (const marker of listing.markers) {
        if (marker.how !== 'drop' || marker.after <= from.copy) continue;
        const undone = markerName(key, 'undone', marker.after, marker.id);
        if (at(undone).exists) at(marker.name).delete();
        else at(marker.name).rename(undone);
      }
    }
    session.readFrom = undefined;
    listing = listed(key, session, steady);
  }
  for (const copy of listing.copies) {
    if (copy.name !== names.kept && copy.name !== names.next) continue;
    const name = placeName(key, copy.order);
    at(copy.name).rename(name);
    carried(session, copy.name, name);
  }
}

/**
 * Write the records as a copy of their own, so that a phone killed at any point keeps a whole copy, and one that
 * loses power keeps a whole copy that had time to reach the disk: written in full as `.part`, then renamed to its
 * name, which says its place, when it was written by the steady clock and which start of the app wrote it (a rename
 * never writes over a file). Older copies go by the rules (recordCopies.ts, `tidy`). Nothing but the new copy is
 * written, and, empty, the mark of a new phone, or of a clear or a drop the phone had no room for before.
 */
async function writeFile(key: string, value: string): Promise<void> {
  const session = sessionOf(key);
  startOf(session, clocksNow().steady);
  await settle(key, session);
  const names = namesOf(key);
  if (session.fresh) {
    try {
      await at(markerName(key, 'clear', 0)).write('');
      session.fresh = false;
    } catch {
      // Tried again at the next save.
    }
  }
  try {
    await at(names.part).write(value);
  } catch (error) {
    // Half a copy would only fill a full phone more.
    dropPart(key);
    throw error;
  }
  const now = clocksNow();
  const { copies, markers } = listed(key, session, now.steady);
  if (session.forgetting) {
    // The mark of a clear or a drop the phone had no room for: it has room now, since what was just written fit.
    const made = await markFor(key, session, copies, markers, true);
    if (made) markers.push(made);
    else if (session.forgetting.how === 'clear' && (copies.length > 0 || session.row)) {
      // Saved with no mark, what this clears could be read again after a power cut. It is held in memory, and said, as
      // any save the phone has no room for is (recordGuard.ts), and the next save tries again.
      dropPart(key);
      throw new Error('No room on the phone for the mark of a clear.');
    } else session.forgetting = undefined;
  }
  const start = startOf(session, now.steady);
  const name = copyName(key, nextOrder(copies, now.wall, forgottenBefore(markers)), now.steady, bootClock(start) ? 'boot' : 'app', start.startedAt);
  at(names.part).rename(name);
  session.held.set(name, { firstSeen: now.steady, own: true, known: true });
  await tidy(key, copies[0]?.name);
}

/** Take away a copy still being written, or that a killed save left half written. Left if it cannot be: the next save writes over it. */
function dropPart(key: string): void {
  try {
    const part = at(namesOf(key).part);
    if (part.exists) part.delete();
  } catch {
    // Written over by the next save.
  }
}

/**
 * Write the mark of the clear or the drop the store said is coming (`forgetting`), naming the first place a copy after
 * it takes. With no room for a new file, a clear's own save (`atSave`) makes its mark of the oldest copy from before
 * it: renamed to the mark's name first, so that from then on it is never read (killed between, the clear is made all
 * the same), then emptied, which takes no room. The marks of drops undone that this makes again go, at a clear every
 * one. The mark made, or null when it could not be.
 */
async function markFor(key: string, session: Session, copies: Copy[], markers: Marker[], atSave: boolean): Promise<Marker | null> {
  const forgetting = session.forgetting;
  if (!forgetting) return null;
  const name = markerName(key, forgetting.how, Math.max(afterEvery(copies), forgottenBefore(markers)), forgetting.id);
  try {
    await at(name).write('');
  } catch {
    const oldest = copies[copies.length - 1];
    if (!atSave || forgetting.how !== 'clear' || !oldest) return null;
    try {
      at(oldest.name).rename(name);
    } catch {
      return null;
    }
    session.held.delete(oldest.name);
    copies.splice(copies.indexOf(oldest), 1);
    try {
      await at(name).write('');
    } catch {
      // A mark that still holds what was cleared: never read, and it goes with the other marks.
    }
  }
  session.forgetting = undefined;
  session.fresh = false;
  // The drops undone that this makes again: every one, for a clear; for a drop, those of the same account.
  const remade = (m: Marker) => m.how === 'undone' && (forgetting.how === 'clear' || m.id === forgetting.id);
  for (const marker of markers.filter(remade)) {
    try {
      at(marker.name).delete();
    } catch {
      // Let go with the next drop or clear made for it.
    }
  }
  session.undone = forgetting.how === 'clear' ? [] : session.undone.filter((m) => m.id !== forgetting.id);
  return markerOf(key, name);
}

/**
 * The next save empties the phone (`clear`) or takes one person's account and hourly rate off it (`drop`, with the
 * account's id). A mark is written first, naming the first place a copy after it takes (and, for a drop, the account),
 * so that a restart or a power cut still knows which copies are from before it. It goes once a copy after it has
 * settled, at a later save or on a timer with the app idle. The mark holds nothing, so a power cut cannot tear it, and a
 * file system puts the changes made after it on the disk after it. A copy a killed save left half written goes first:
 * it may hold what this takes off.
 *
 * - After a clear no copy from before it is read again, and the save after it lets go of every one: with nothing saved
 *   since whole (a power cut tore it, or the app was killed first), the phone opens as the build starts, never on what
 *   was cleared and never on Records not read.
 * - After a drop, until a copy after it has settled, a power cut can bring back a copy from before it, with the
 *   account and the hourly rate still in it: the phone says it shut off while saving, and which drop was undone
 *   (`undoneDrops`), and the store makes it again; the rest of what is on the phone is not lost for it.
 *
 * With no room for the mark now, the save that follows makes it (`markFor`); a clear's save that cannot is not written.
 */
async function forget(key: string, how: Forgetting, id?: string): Promise<void> {
  if (!IN_FILE) return;
  const session = sessionOf(key);
  const { steady } = clocksNow();
  startOf(session, steady);
  session.forgetting = { how, id };
  await settle(key, session);
  dropPart(key);
  const { copies, markers } = listed(key, session, steady);
  await markFor(key, session, copies, markers, false);
}

/**
 * Let go of what the copies that have settled make safe to let go of (recordCopies.ts, `toLetGo`). The anchor is the
 * newest copy settled on the disk and known whole; one this session has not read is read once, and goes if it is
 * torn. With an anchor, an older version's row goes (not when this is the store's read, `atRead`), and once every copy
 * to go has gone, the marks of a clear or a drop it is after. Only once the store has read the records: a start whose
 * read the store could not make sense of lets go of nothing. Then waits for the next copy to settle (`schedule`).
 */
async function tidy(key: string, replaced?: string, atRead = false): Promise<void> {
  const session = sessionOf(key);
  if (!session.storeRead) return;
  const now = clocksNow();
  const start = startOf(session, now.steady);
  let listing: Listed;
  try {
    listing = listed(key, session, now.steady);
  } catch {
    return;
  }
  const readable = readableAfter(listing.markers);
  // A copy written before the phone last started says so in its name, so that a later start whose clock has passed
  // its time does not take it for one of its own boot. Kept as it was if the rename does not work.
  let copies = listing.copies.map((copy) => {
    if (copy.clock !== 'boot' || copy.steady === null || !fromEarlierBoot(copy, now, start)) return copy;
    const name = copyName(key, copy.order, copy.steady, 'earlier', copy.session);
    try {
      at(copy.name).rename(name);
    } catch {
      return copy;
    }
    carried(session, copy.name, name);
    return { ...copy, name, clock: 'earlier' as const };
  });
  let anchor: Copy | null = null;
  const candidates = settledNewestFirst(
    copies.filter((c) => c.order >= readable),
    now,
    start,
  );
  for (const copy of candidates) {
    if (!copy.known) {
      let text: string;
      try {
        text = await at(copy.name).text();
      } catch {
        break;
      }
      if (!whole(text)) {
        try {
          deleted(session, copy.name);
          copies = copies.filter((c) => c !== copy);
        } catch {
          // Never read while an older copy is whole.
        }
        continue;
      }
      seen(session, copy.name, now.steady).known = true;
      copy.known = true;
    }
    anchor = copy;
    break;
  }
  let done = true;
  for (const copy of toLetGo(copies, { now, start, anchor, readable, replaced: copies.find((c) => c.name === replaced) })) {
    try {
      deleted(session, copy.name);
    } catch {
      done = false;
    }
  }
  if (anchor) {
    if (session.row && !atRead) {
      try {
        await AsyncStorage.removeItem(key);
        session.row = false;
      } catch {
        done = false;
      }
    }
    // The marks last: while a clear's is there, nothing from before it is read.
    for (const marker of done ? listing.markers : []) {
      if (marker.how === 'undone' || marker.after > anchor.order) continue;
      try {
        at(marker.name).delete();
      } catch {
        // Let go at the next save.
      }
    }
  }
  schedule(key);
}

/** With the app idle, tidy once the next copy that has not settled yet does. */
function schedule(key: string): void {
  const session = sessionOf(key);
  if (session.timer !== undefined) clearTimeout(session.timer);
  session.timer = undefined;
  if (!session.storeRead) return;
  const now = clocksNow();
  let wait: number | null;
  try {
    wait = settlesIn(listed(key, session, now.steady).copies, now, startOf(session, now.steady));
  } catch {
    return;
  }
  if (wait === null) return;
  const timer = setTimeout(
    () => {
      records.queue(key, () => tidy(key)).catch(() => undefined);
    },
    Math.max(1, Math.ceil(wait)),
  );
  // Under Node (the tests) a waiting timer would hold the process open; a phone's timer is a number, with no unref.
  (timer as unknown as { unref?: () => void }).unref?.();
  session.timer = timer;
}

async function removeFile(key: string): Promise<void> {
  const session = sessions.get(key);
  if (session?.timer !== undefined) clearTimeout(session.timer);
  sessions.delete(key);
  const names = namesOf(key);
  for (const entry of Paths.document.list()) {
    const name = entry.name;
    if (name === names.part || name === names.kept || name === names.next || copyOf(key, name) || markerOf(key, name)) at(name).delete();
  }
}

/**
 * Move an older version's row into the file. The row is not removed now: what was just written may not have
 * reached the disk, and a power cut in the next minute could leave it torn. It goes once a copy of the file has
 * settled by the steady clock (`tidy`), at a later save or on a timer, at this start or a later one. A copy that does
 * not read back the same is not left to be read in the row's place.
 */
async function moveRow(key: string, row: string): Promise<void> {
  let same = false;
  try {
    await writeFile(key, row);
    const found = await readFile(key);
    same = (found.kind === 'whole' || found.kind === 'torn') && found.text === row;
  } catch {
    same = false;
  }
  if (same) {
    sessionOf(key).row = true;
    return;
  }
  try {
    await removeFile(key);
  } catch {
    // Nothing more to do: the next start reads what is there.
  }
}

/**
 * At a start that read the files, whether an older version's row is still in AsyncStorage: if so, it goes once a copy
 * of the file has settled. Not at the read: by the phone's clock a copy written seconds before a restart can look long
 * settled.
 */
async function noteRow(key: string, session: Session): Promise<void> {
  try {
    if ((await AsyncStorage.getAllKeys()).includes(key)) session.row = true;
  } catch {
    // Looked for again at the next start.
  }
}

// ---- The records, in AsyncStorage (iPhone) -------------------------------------------------

/*
 * RNCAsyncStorage (ios/RNCAsyncStorage.mm) keeps every key in a manifest, which it reads from the disk once, when the
 * app starts, and writes back whole at its next change of any key. A value of up to 1,024 characters is held in the
 * manifest itself; a longer one, as the records are within days, in a file of its own, named by the MD5 of the key,
 * in Library/Application Support/<bundle id>/RCTAsyncLocalStorage_V1. When it cannot read a value's file, it takes
 * the key off the manifest it holds and fails; asked again it says there is nothing, and once that manifest is
 * written, at the next change of any key, no RNCAsyncStorage looks at that file again, though it is still there.
 *
 * So, on the iPhone:
 * - A read that fails writes nothing to AsyncStorage. Nothing else can, before a restart: the store writes nothing
 *   over records it has not read (recordGuard.ts), and while it has not, the app shows Records not read and starts
 *   nothing else (App.tsx), the server session (`safeStorage`, which supabase-js writes only once a screen or the
 *   sending has made its client) among it.
 * - When AsyncStorage says there is nothing, the records' own file is read (`valueFileOf`): whole JSON, it is the
 *   records, and the save the store makes as it opens lists the key again; there but not whole, the read fails.
 * - With no file either, the mark (`markOf`) says whether records were kept here: with it, the read fails; without,
 *   this is a new phone.
 */

/** RNCAsyncStorage's folder (RCTStorageDirectory) under Application Support/<bundle id>. */
const ASYNC_FOLDER = 'RCTAsyncLocalStorage_V1';
/** The longest value RNCAsyncStorage holds in its manifest (RCTInlineValueThreshold): a longer one has a file of its own. */
const INLINE_LIMIT = 1024;

/**
 * The file RNCAsyncStorage keeps the value of `key` in when it is longer than INLINE_LIMIT, or null with none:
 * Library/Application Support/<bundle id>/RCTAsyncLocalStorage_V1/<MD5 of the key> (RCTCreateStorageDirectoryPath,
 * _filePathForKey, RCTMD5Hash). Library is the folder above Paths.cache (Library/Caches). The bundle id is not
 * asked for: the folder is found under Application Support, where RNCAsyncStorage makes it under the app's own
 * bundle id and nothing else makes one. expo-file-system reads there (an app's own container, outside its document
 * and cache folders, is left to iOS's sandbox: FileSystemUtilities.getExternalPathPermissions). Throws when it
 * cannot tell: Application Support is there but cannot be listed, or more than one folder holds such a file.
 */
function valueFileOf(key: string): File | null {
  const support = new Directory(Paths.cache.parentDirectory, 'Application Support');
  if (!support.exists) return null;
  const name = md5(key);
  const found = support
    .list()
    .map((entry) => new File(entry.uri, ASYNC_FOLDER, name))
    .filter((file) => file.exists);
  if (found.length > 1) throw new Error('More than one copy of AsyncStorage is on this phone: the records are not taken from either.');
  return found[0] ?? null;
}

/**
 * On the iPhone, the mark that records are kept under a key: a few bytes, held in AsyncStorage's manifest, there
 * from the first save or read of them that works, and taken off only with the records. Without it, a phone whose
 * AsyncStorage had lost track of its records and whose records' file was gone too would open as a new phone, and
 * its first save would put an empty phone's records in their place.
 */
const markOf = (key: string) => `${key}:on-this-phone`;
/** Keys whose mark this session knows is there. */
const marked = new Set<string>();

/** Only once a read or a save of the records has worked: a write after a read that failed would put RNCAsyncStorage's manifest on the disk without them. */
async function markKept(key: string): Promise<void> {
  if (marked.has(key)) return;
  try {
    if ((await AsyncStorage.getItem(markOf(key))) === null) await AsyncStorage.setItem(markOf(key), '1');
    marked.add(key);
  } catch {
    // Put there by the next save or read that works.
  }
}

async function readRow(key: string): Promise<string | null> {
  // A read that fails throws here and writes nothing.
  const saved = await AsyncStorage.getItem(key);
  if (saved !== null) {
    await markKept(key);
    return saved;
  }
  // AsyncStorage lists nothing. Its manifest may have lost the key while the records' file is still there.
  const file = valueFileOf(key);
  if (file) {
    const text = await file.text();
    if (!whole(text)) throw new Error('The records on this phone are there, but not whole.');
    await markKept(key);
    return text;
  }
  // No file either. On a phone that has kept records here, that is AsyncStorage having lost them.
  if ((await AsyncStorage.getItem(markOf(key))) !== null) throw new Error('The records on this phone could not be found where they are kept.');
  return null;
}

/**
 * Take away a file of the records RNCAsyncStorage no longer has listed, so that it is never read in their place:
 * after a save short enough to be held in the manifest, or a removal. RNCAsyncStorage takes such a file away itself
 * only while its manifest marks the key as kept in one, which after a read from the file (`readRow`) it does not,
 * until the next save of a longer value.
 */
function dropUnlisted(key: string): void {
  valueFileOf(key)?.delete();
}

// ---- The records ---------------------------------------------------------------------------

async function readRecords(key: string): Promise<string | null> {
  if (!IN_FILE) return readRow(key);
  const session = sessionOf(key);
  session.passedOver = false;
  session.undone = [];
  session.fresh = false;
  const found = await readFile(key);
  if (found.kind === 'cleared') {
    // Emptied, and nothing saved since is whole: the phone opens as the build starts. Said as a shut-off only when
    // something saved after the clear was there and torn.
    session.passedOver = found.passedOver;
    await noteRow(key, session);
    return null;
  }
  if (found.kind === 'whole') {
    session.passedOver = found.passedOver;
    session.undone = found.markers.filter((m) => m.how === 'undone' || (m.how === 'drop' && m.after > found.order));
    await noteRow(key, session);
    return found.text;
  }
  // Kept in AsyncStorage by an older version of the app. A row too big to hand back fails here, and is left there.
  const row = await AsyncStorage.getItem(key);
  if (row === null) {
    if (found.kind === 'torn') return found.text;
    // Nothing of the records anywhere: a new phone.
    session.fresh = true;
    return null;
  }
  if (found.kind === 'torn') {
    // Files are there, but none is whole: a power cut soon after the row was moved tore what was written since.
    // The row is read; the torn files go at the first save (`settle`), and the row once a copy has settled.
    session.readFrom = { row: true };
    session.passedOver = true;
    session.row = true;
    // Older than every copy: older than every drop made since, too.
    session.undone = found.markers.filter((m) => m.how === 'undone' || m.how === 'drop');
    return row;
  }
  await moveRow(key, row);
  return row;
}

async function writeRecords(key: string, value: string): Promise<void> {
  if (!IN_FILE) {
    await AsyncStorage.setItem(key, value);
    await markKept(key);
    if (value.length <= INLINE_LIMIT) {
      try {
        dropUnlisted(key);
      } catch {
        // Tried again at the next such save. The save itself worked.
      }
    }
    return;
  }
  // Only the store's own saves come here, once it has read the records (recordGuard.ts).
  sessionOf(key).storeRead = true;
  await writeFile(key, value);
}

async function removeRecords(key: string): Promise<void> {
  if (IN_FILE) {
    await removeFile(key);
    await AsyncStorage.removeItem(key);
    return;
  }
  // The mark goes first: a mark left with no records would keep the phone from opening.
  await AsyncStorage.removeItem(markOf(key));
  marked.delete(key);
  await AsyncStorage.removeItem(key);
  dropUnlisted(key);
}

/**
 * The store has read the records and made sense of them: what was read is put in place now (`settle`), and what has
 * settled is let go of (`tidy`), rather than at the first save, so that a start that saves nothing still does it. An
 * older version's row stays: it goes only at a save or on the timer, never at a read.
 */
async function opened(key: string): Promise<void> {
  if (!IN_FILE) return;
  const session = sessionOf(key);
  session.storeRead = true;
  await settle(key, session);
  await tidy(key, undefined, true);
}

const records = guardRecords({ read: readRecords, write: writeRecords, remove: removeRecords, forget, opened });

/**
 * The store's records: in a file on Android, in AsyncStorage on the iPhone. Reads, saves and removals of a key
 * happen one at a time, in the order asked. A read that fails is not taken for a phone with nothing saved: it
 * fails, and nothing is written over what could not be read (recordGuard.ts).
 */
export const recordStorage: StateStorage = records.recordStorage;

/** The store has read what was saved under `key`, and its saves from now on are written to the phone. */
export const recordsRead = records.recordsRead;

/** Told whether a save of the records is waiting in memory because the phone could not write it (recordGuard.ts). */
export const watchUnsaved = records.watchUnsaved;

/**
 * Called by the store just before it saves to empty the phone (`clear`: signing out of it, clearing it, deleting an
 * account with it) or to take one person's account and hourly rate off it (`drop`, with that account's id, which the
 * drop's mark names): after a clear the copies kept from before go with that save, after a drop as soon as a copy
 * after it has settled (`forget`). Only on Android, where older copies are kept; the iPhone keeps one.
 */
export const forgetCopies = records.forgetCopies;

/**
 * Whether the last read of the records under `key` passed over a newer copy that was there and was not whole:
 * the phone shut off while saving (a power cut, a forced restart), and the last changes before that may not be on
 * it. Only on Android, where the records are a file; never saved itself.
 */
export function passedOverNewer(key: string): boolean {
  return sessions.get(key)?.passedOver ?? false;
}

/**
 * Whether the copy the last read of the records under `key` took is older than a drop the store made (taking one
 * person's account and hourly rate off the phone, `forgetCopies(key, 'drop', id)`): a power cut undid it, and what it
 * took off is back. The store makes it again (`undoneDrops` says whose). Said at every start until it does, by a mark
 * that stays on the phone; the drop made again for that account, or a clear, takes it away. Only on Android, where
 * older copies are kept.
 */
export function dropUndone(key: string): boolean {
  return undoneDrops(key).length > 0;
}

/**
 * The drops `dropUndone` says a power cut undid, each by the id of the account it took off, as the store named it
 * (`forgetCopies(key, 'drop', id)`), or null for one whose mark names none (an earlier build's). The store makes each
 * again. Empty on the iPhone and the web, which keep one copy.
 */
export function undoneDrops(key: string): (string | null)[] {
  if (!IN_FILE) return [];
  return [...new Set((sessions.get(key)?.undone ?? []).map((m) => m.id ?? null))];
}

/**
 * Whether the records under `key` are kept only in memory for this session. Never on a phone: a read that fails
 * here fails, and the app says the records could not be read. Only a browser that will not let the app at its
 * storage keeps them in memory (storage.ts).
 */
export function keptInMemory(_key: string): boolean {
  return false;
}

/**
 * Whether another tab saves the records under `key`, so this one saves nothing (storage.ts, the web's). A phone runs
 * one MineMuster at a time: never.
 */
export function inAnotherTab(_key: string): boolean {
  return false;
}

/** Told when another tab of a browser takes the records, or this one has them again (storage.ts). Never on a phone. */
export function watchOtherTabs(_listener: (key: string, here: boolean) => Promise<void> | void): () => void {
  return () => undefined;
}

/** Take the records for this tab of a browser (storage.ts). A phone already has them. */
export function takeRecords(_key: string): Promise<void> {
  return Promise.resolve();
}
