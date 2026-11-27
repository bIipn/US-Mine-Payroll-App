import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type { StateStorage } from 'zustand/middleware';

import { md5 } from '../util/hash';
import {
  afterEvery,
  checkpointDue,
  checkpointName,
  checkpointOrder,
  forgottenBefore,
  heldAfter,
  isSettled,
  markerName,
  markerOf,
  newestFirst,
  nextOrder,
  readableAfter,
  settlesIn,
  toLetGo,
  type Checkpoint,
  type Clocks,
  type Forgetting,
  type Marker,
} from './recordCopies';
import { guardRecords } from './recordGuard';

/**
 * Device storage on iPhone and Android. storage.ts is the web's, and holds the shared types.
 *
 * The store's records (`recordStorage`) are one value that grows with every punch, checklist, exam and request,
 * and none of it is ever pruned. On Android they are kept in a file of their own, in the app's private files:
 * AsyncStorage keeps a value in one SQLite row, and Android cannot hand back a row over about 2 MB (it must fit
 * one CursorWindow), which a phone's records pass in months. A phone that kept them in AsyncStorage under an
 * older version has them moved into the file the first time they are read; the row stays until this session has
 * held a whole copy of the file long enough for it to have reached the disk. On the iPhone they stay in AsyncStorage, where they have
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
 * power cut can tear what was written in the last half a minute or so. A copy is read only if it is whole JSON, and
 * the file is kept aside now and then as a checkpoint, so that a whole copy that has had time to reach the disk is
 * always there; whether one has is judged by a steady clock, never by the phone's own, which can jump. When a newer
 * copy was torn and an older one was read, the store is told (`passedOverNewer`) and the app says so once. When the
 * store empties the phone, or takes one person's records off it, it says so first (`forgetCopies`), and the copies
 * from before go as soon as that save has settled.
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
 * The records' files, by name: the one that is read; a whole new copy, about to take its place; a copy being
 * written. The checkpoints are beside them (recordCopies.ts), and so may be the copy before the last that an
 * earlier build of this version kept (`.prev`), read as the oldest checkpoint, and the marks of a clear or a drop.
 */
function namesOf(key: string) {
  return { kept: `${key}.json`, next: `${key}.json.next`, part: `${key}.json.part` };
}

/** A file in the app's files. Made new for each step, since a move or a rename points the File it was asked of at where the file went. */
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
  /**
   * By the steady clock, since when this session has held what the copy holds: when it wrote it (its `.part`), or,
   * for a copy that was there before, when it first saw it. A copy from before may have been written seconds before
   * the app was killed, so it settles only once this session has held it two minutes.
   */
  since: number;
  /** Whether this session knows it whole: it wrote it, or read it whole. */
  known: boolean;
}

/** A clear or a drop whose copies from before have not all gone yet (`tidy`). */
interface Forget {
  /** The first place a checkpoint made after it takes: every one before this is from before it. */
  after: number;
  /** Whether the file now holds what was saved after it. Until the save after it, it holds what came before. */
  keptAfter: boolean;
}

/** Where the store's records were read from, until the next save has put that in place (`settle`). */
type ReadFrom =
  | { copy: 'next' }
  | { copy: 'kept' }
  | { copy: 'row' }
  | { copy: 'checkpoint'; order: number }
  /** Emptied by a clear, with nothing saved since it whole: every copy at `after` or later is torn. */
  | { copy: 'cleared'; after: number };

/** What this session keeps about the records of one key. Never saved: a new start knows only what is in the files. */
interface Session {
  held: Map<string, Held>;
  /** When this session last kept the file aside as a checkpoint, by the steady clock. */
  madeAt?: number;
  readFrom?: ReadFrom;
  /** Whether the last read passed over a newer copy that was there and was not whole. */
  passedOver: boolean;
  /**
   * An older version's row, still in AsyncStorage: it goes once this session has held a whole copy of the file two
   * minutes, from `since` by the steady clock (undefined until this session holds one).
   */
  row?: { since?: number };
  forget?: Forget;
  /** The next save keeps nothing aside: it is the one that takes one person's records off the phone. */
  noCheckpoint: boolean;
  /** The store has read the records and saves them: nothing goes before then (`tidy`). */
  storeRead: boolean;
  /** The timer that lets go of what has settled with the app idle (`schedule`). */
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();
function sessionOf(key: string): Session {
  let session = sessions.get(key);
  if (!session) sessions.set(key, (session = { held: new Map(), passedOver: false, noCheckpoint: false, storeRead: false }));
  return session;
}

/** This session has seen a copy. One it has no time for yet was there before: it counts as written now. */
function seen(session: Session, name: string, steady: number): Held {
  let held = session.held.get(name);
  if (!held) session.held.set(name, (held = { since: steady, known: false }));
  return held;
}

/** A copy went from one name to another (a move or a rename): what this session knows of it goes with it. */
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
  /** The checkpoints of the key, newest first. */
  checkpoints: Checkpoint[];
  /** The marks of a clear or a drop beside them. */
  markers: Marker[];
}

/** The checkpoints of `key` in the app's files, newest first, and the marks beside them. Throws when the files cannot be listed. */
function listed(key: string, session: Session, steady: number): Listed {
  const checkpoints: Checkpoint[] = [];
  const markers: Marker[] = [];
  for (const entry of Paths.document.list()) {
    const marker = markerOf(key, entry.name);
    if (marker) {
      markers.push(marker);
      continue;
    }
    const order = checkpointOrder(key, entry.name);
    if (order === null) continue;
    const held = seen(session, entry.name, steady);
    checkpoints.push({ name: entry.name, order, writtenAt: writtenAt(entry.name), since: held.since, known: held.known });
  }
  return { checkpoints: newestFirst(checkpoints), markers };
}

/**
 * The marks of a clear or a drop found at a start: what came before them goes once a copy after them has settled,
 * as in the session that made them. Whatever the file holds then is the newest there is: a clear takes the file it
 * clears away just after its mark is written, and a drop whose save never came holds what the store had, and read.
 */
function noteMarks(session: Session, markers: readonly Marker[]): void {
  if (markers.length === 0) return;
  const after = Math.max(forgottenBefore(markers), session.forget?.after ?? 0);
  session.forget = { after, keptAfter: session.forget?.keptAfter ?? true };
}

/** What the newest readable copy of the records holds. */
interface Found {
  text: string;
  /** Whether it is whole JSON. With no copy whole, the newest is handed back as it is. */
  whole: boolean;
  /** The copy it was read from. */
  name: string;
  /** Whether a newer copy was there, was not whole, and was passed over for this one. */
  passedOver: boolean;
}

/**
 * The records in the files, or null with none: the newest copy that is whole, read newest first: the new copy
 * beside the file (a save writes it whole before it takes the file's place), the file, then the checkpoints,
 * newest first. Never a copy still being written (`part`), and never a checkpoint from before a clear (a mark says
 * which): when nothing saved since the clear is whole, `cleared`, and the phone opens as the build starts. A copy
 * that cannot be read at all fails the read: it is not passed over, since what is in it may be the newest. With no
 * copy whole, the newest is handed back as it is, and the store, which cannot read it either, says so.
 */
async function readFile(key: string): Promise<Found | 'cleared' | null> {
  const names = namesOf(key);
  const session = sessionOf(key);
  const { steady } = clocksNow();
  let listing: Listed | null = null;
  try {
    listing = listed(key, session, steady);
    noteMarks(session, listing.markers);
  } catch {
    // Listed again below, where it must be: the file and the copy beside it are never from before a clear.
  }
  let newest: Found | null = null;
  const look = async (name: string, from: ReadFrom): Promise<Found | null> => {
    const held = seen(session, name, steady);
    const text = await at(name).text();
    if (whole(text)) {
      held.known = true;
      session.readFrom = from;
      return { text, whole: true, name, passedOver: newest !== null };
    }
    newest ??= { text, whole: false, name, passedOver: false };
    return null;
  };
  for (const copy of ['next', 'kept'] as const) {
    if (!at(names[copy]).exists) continue;
    const found = await look(names[copy], { copy });
    if (found) return found;
  }
  if (!listing) {
    listing = listed(key, session, steady);
    noteMarks(session, listing.markers);
  }
  const readable = readableAfter(listing.markers);
  for (const checkpoint of listing.checkpoints) {
    if (checkpoint.order < readable) continue;
    const found = await look(checkpoint.name, { copy: 'checkpoint', order: checkpoint.order });
    if (found) return found;
  }
  if (listing.markers.some((m) => m.how === 'clear')) {
    session.readFrom = { copy: 'cleared', after: readable };
    return 'cleared';
  }
  return newest;
}

/**
 * Before the first save after a read, put what was read in place, and take away every copy newer than it, which
 * were torn: so that none of them is ever kept aside as a checkpoint, or taken for a whole copy settled on the
 * disk and let an older whole one go. Never a copy from before a clear: those go once a save after it has settled.
 * Done again until it works.
 */
async function settle(key: string, session: Session): Promise<void> {
  const from = session.readFrom;
  if (!from) return;
  const names = namesOf(key);
  if (from.copy === 'next') {
    // The newest copy was whole beside the file: it takes the file's place, whatever the file holds.
    await at(names.next).move(at(names.kept), { overwrite: true });
    carried(session, names.next, names.kept);
  } else if (from.copy === 'kept') {
    if (at(names.next).exists) deleted(session, names.next);
  } else {
    // Read from a checkpoint or from an older version's row, or emptied with nothing whole saved since: every copy
    // of the files newer than that is torn.
    for (const name of [names.next, names.kept]) if (at(name).exists) deleted(session, name);
    for (const checkpoint of listed(key, session, clocksNow().steady).checkpoints) {
      const torn = from.copy === 'row' || (from.copy === 'checkpoint' ? checkpoint.order > from.order : checkpoint.order >= from.after);
      if (torn) deleted(session, checkpoint.name);
    }
  }
  session.readFrom = undefined;
}

/**
 * Write the records to the file, so that a phone killed at any point keeps a whole copy, and one that loses power
 * keeps a whole copy that had time to reach the disk. A move over a file deletes that file before it renames
 * (expo-file-system, on Android and iOS alike), so the new copy is written in full beside the file and renamed to
 * stand next to it, then takes the file's place. When a checkpoint is due (at most once a minute), the file is
 * first renamed into a new checkpoint instead of being deleted by that move; and checkpoints older than the newest
 * one settled on the disk and known whole are let go (recordCopies.ts). Nothing but the new copy is written.
 */
async function writeFile(key: string, value: string): Promise<void> {
  const session = sessionOf(key);
  await settle(key, session);
  const names = namesOf(key);
  try {
    await at(names.part).write(value);
  } catch (error) {
    // Half a copy would only fill a full phone more.
    try {
      if (at(names.part).exists) at(names.part).delete();
    } catch {
      // The next save writes over it.
    }
    throw error;
  }
  session.held.set(names.part, { since: clocksNow().steady, known: true });
  await at(names.part).move(at(names.next), { overwrite: true });
  carried(session, names.part, names.next);

  const now = clocksNow();
  let checkpoints: Checkpoint[] | null = null;
  try {
    checkpoints = listed(key, session, now.steady).checkpoints;
  } catch {
    // Not listed this time: the file is replaced as between checkpoints, and none is let go.
  }
  // The save that takes one person's records off the phone keeps none of them aside: the copies from before are
  // there meanwhile, and go once it has settled (`forget`).
  const keepNone = session.noCheckpoint;
  session.noCheckpoint = false;
  if (checkpoints && !keepNone && at(names.kept).exists && checkpointDue(checkpoints, now, session.madeAt)) {
    const order = nextOrder(checkpoints, now.wall, session.forget?.after ?? 0);
    const name = checkpointName(key, order);
    const when = writtenAt(names.kept);
    try {
      at(names.kept).rename(name);
      carried(session, names.kept, name);
      // Made from the file, which by then this session has always read whole or written itself (`settle`).
      const held = session.held.get(name) ?? { since: now.steady, known: true };
      held.known = true;
      session.held.set(name, held);
      session.madeAt = now.steady;
      checkpoints = [...checkpoints, { name, order, writtenAt: when, since: held.since, known: true }];
    } catch {
      // Not kept aside this time: the move below replaces the file, as between checkpoints.
    }
  }
  await at(names.next).move(at(names.kept), { overwrite: true });
  carried(session, names.next, names.kept);
  if (session.forget) session.forget.keptAfter = true;
  if (session.row && session.row.since === undefined) session.row.since = session.held.get(names.kept)?.since;

  for (const old of checkpoints ? toLetGo(checkpoints, now.steady) : []) {
    try {
      deleted(session, old.name);
    } catch {
      // Let go at the next save.
    }
  }
  await tidy(key);
}

/**
 * The next save empties the phone (`clear`) or takes one person's account and hourly rate off it (`drop`). That
 * save keeps nothing of what it takes off aside as a checkpoint, and every copy from before it (the checkpoints,
 * `.prev`, an older version's row) goes as soon as it has settled by the steady clock, at a later save or on a timer
 * with the app idle: what was taken off does not outlive it by much more than two minutes.
 *
 * A mark is written first, which names the first place a checkpoint after it takes: a restart or a power cut before
 * those copies have gone still knows which they are, and lets them go at the next start once a copy after the mark
 * has settled there. The mark holds nothing, so a power cut cannot tear it, and a file system puts the changes made
 * after it on the disk after it: whatever of this reached the disk, the mark did too.
 *
 * - A clear then takes the file it clears away, so the file is only ever what was saved after it. While a clear's
 *   mark is there no copy from before it is read: with nothing saved since whole (a power cut tore it, or the app
 *   was killed first), the phone opens as the build starts, never on what was cleared and never on Records not
 *   read. The copies from before stay unread until then, in case the mark itself did not reach the disk.
 * - A drop leaves the file to the save after it, which replaces it. Until that save has settled, a power cut can
 *   bring back a copy from before it, with the account and the hourly rate still in it, and the phone says it shut
 *   off while saving: the rest of what is on the phone must not be lost for them. With no checkpoint at all to fall
 *   back on, the file is kept aside instead, as one of the copies from before, and goes with them.
 *
 * If the files cannot be listed, nothing is done, and the save that follows is an ordinary one.
 */
async function forget(key: string, how: Forgetting): Promise<void> {
  if (!IN_FILE) return;
  const session = sessionOf(key);
  await settle(key, session);
  const names = namesOf(key);
  const now = clocksNow();
  const { checkpoints, markers } = listed(key, session, now.steady);
  let after = Math.max(afterEvery(checkpoints), forgottenBefore(markers), session.forget?.after ?? 0);
  const aside = how === 'drop' && checkpoints.length === 0 && at(names.kept).exists ? nextOrder(checkpoints, now.wall, after) : null;
  if (aside !== null) after = aside + 1;
  try {
    await at(markerName(key, how, after)).write('');
  } catch {
    // A phone too full for an empty file: the copies from before still go once the save after this has settled,
    // unless the app is closed first.
  }
  session.forget = { after, keptAfter: false };
  // A copy beside the file, or half of one a killed save left, holds what came before too.
  for (const name of [names.next, names.part]) if (at(name).exists) deleted(session, name);
  if (how === 'clear') {
    if (at(names.kept).exists) deleted(session, names.kept);
  } else if (aside !== null) {
    const name = checkpointName(key, aside);
    try {
      at(names.kept).rename(name);
      carried(session, names.kept, name);
    } catch {
      // Not kept aside: the save after this keeps none of it aside either.
      session.noCheckpoint = true;
    }
  } else {
    session.noCheckpoint = true;
  }
}

/**
 * The copies that count as made after a clear or a drop: the checkpoints (by their place), and the file once a save
 * since has put it in place, newer than every checkpoint.
 */
function copiesAfter(key: string, session: Session, checkpoints: readonly Checkpoint[]): Pick<Checkpoint, 'order' | 'since' | 'known'>[] {
  const { kept } = namesOf(key);
  const held = session.forget?.keptAfter && at(kept).exists ? session.held.get(kept) : undefined;
  return held ? [...checkpoints, { order: Number.POSITIVE_INFINITY, since: held.since, known: held.known }] : [...checkpoints];
}

/**
 * Let go of what a copy that has settled makes safe to let go of: an older version's row, once this session has held
 * a whole copy of the file two minutes; and after a clear or a drop, once a copy after it has settled, every copy
 * from before it and then its marks. Only once the store has read the records: a start whose read the store could
 * not make sense of lets go of nothing. Then waits for the next thing to settle (`schedule`).
 */
async function tidy(key: string): Promise<void> {
  const session = sessionOf(key);
  if (!session.storeRead) return;
  const { steady } = clocksNow();
  if (session.row?.since !== undefined && isSettled({ since: session.row.since }, steady)) {
    try {
      await AsyncStorage.removeItem(key);
      session.row = undefined;
    } catch {
      // The next save tries again.
    }
  }
  const forgetting = session.forget;
  if (forgetting) {
    let listing: Listed | null = null;
    try {
      listing = listed(key, session, steady);
    } catch {
      // Listed at the next save.
    }
    if (listing && heldAfter(copiesAfter(key, session, listing.checkpoints), forgetting.after, steady)) {
      let done = true;
      for (const checkpoint of listing.checkpoints) {
        if (checkpoint.order >= forgetting.after) continue;
        try {
          deleted(session, checkpoint.name);
        } catch {
          done = false;
        }
      }
      try {
        if ((await AsyncStorage.getAllKeys()).includes(key)) await AsyncStorage.removeItem(key);
        session.row = undefined;
      } catch {
        done = false;
      }
      // The marks last: while a clear's is there, nothing from before it is read.
      for (const marker of done ? listing.markers : []) {
        if (marker.after > forgetting.after) continue;
        try {
          at(marker.name).delete();
        } catch {
          done = false;
        }
      }
      if (done) session.forget = undefined;
    }
  }
  schedule(key);
}

/**
 * With the app idle, tidy once the next copy that has not settled yet does. Only for what has not settled: what has,
 * and still waits, waits for the next save, so that a deletion the phone keeps refusing is not tried again and again.
 */
function schedule(key: string): void {
  const session = sessionOf(key);
  if (session.timer !== undefined) clearTimeout(session.timer);
  session.timer = undefined;
  const { steady } = clocksNow();
  const waiting: Pick<Checkpoint, 'since'>[] = [];
  if (session.row?.since !== undefined) waiting.push({ since: session.row.since });
  const forgetting = session.forget;
  if (forgetting) {
    const { kept } = namesOf(key);
    for (const [name, held] of session.held) {
      const order = name === kept ? (forgetting.keptAfter ? Number.POSITIVE_INFINITY : null) : checkpointOrder(key, name);
      if (order !== null && order >= forgetting.after && held.known) waiting.push(held);
    }
  }
  const wait = settlesIn(
    waiting.filter((copy) => !isSettled(copy, steady)),
    steady,
  );
  if (wait === null) return;
  const timer = setTimeout(() => {
    records.queue(key, () => tidy(key)).catch(() => undefined);
  }, wait);
  // Under Node (the tests) a waiting timer would hold the process open; a phone's timer is a number, with no unref.
  (timer as unknown as { unref?: () => void }).unref?.();
  session.timer = timer;
}

async function removeFile(key: string): Promise<void> {
  const session = sessions.get(key);
  if (session?.timer !== undefined) clearTimeout(session.timer);
  sessions.delete(key);
  const names = namesOf(key);
  for (const name of [names.next, names.kept, names.part]) if (at(name).exists) at(name).delete();
  for (const entry of Paths.document.list()) {
    if (checkpointOrder(key, entry.name) !== null || markerOf(key, entry.name)) at(entry.name).delete();
  }
}

/**
 * Move an older version's row into the file. The row is not removed now: what was just written may not have
 * reached the disk, and a power cut in the next minute could leave it torn. It goes once this session has held the
 * file two minutes by the steady clock (`tidy`), at a later save or on a timer, or, at a later start, two minutes
 * after that start read the file whole. A copy that does not read back the same is not left to be read in the row's
 * place.
 */
async function moveRow(key: string, row: string): Promise<void> {
  let same = false;
  try {
    await writeFile(key, row);
    const found = await readFile(key);
    same = found !== 'cleared' && found?.text === row;
  } catch {
    same = false;
  }
  if (same) {
    const session = sessionOf(key);
    session.row = { since: session.held.get(namesOf(key).kept)?.since };
    schedule(key);
    return;
  }
  try {
    await removeFile(key);
  } catch {
    // Nothing more to do: the next start reads what is there.
  }
}

/**
 * At a start that read the file whole, whether an older version's row is still in AsyncStorage: if so, it goes once
 * this session has held the copy it read two minutes. Not at the read: by the phone's clock a copy written seconds
 * before a restart can look long settled.
 */
async function noteRow(key: string, session: Session, found: Found): Promise<void> {
  try {
    if ((await AsyncStorage.getAllKeys()).includes(key)) session.row = { since: session.held.get(found.name)?.since };
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
  sessionOf(key).passedOver = false;
  const found = await readFile(key);
  if (found === 'cleared') {
    // Emptied, and nothing saved since is whole: the phone opens as the build starts. Not said as a shut-off: what
    // went is what the person emptied.
    return null;
  }
  const session = sessionOf(key);
  if (found?.whole) {
    session.passedOver = found.passedOver;
    await noteRow(key, session, found);
    schedule(key);
    return found.text;
  }
  // Kept in AsyncStorage by an older version of the app. A row too big to hand back fails here, and is left there.
  const row = await AsyncStorage.getItem(key);
  if (row === null) return found?.text ?? null;
  if (found) {
    // Files are there, but none is whole: a power cut soon after the row was moved tore what was written since.
    // The row is read; the torn files go at the first save (`settle`), and the row once that save has settled.
    session.readFrom = { copy: 'row' };
    session.passedOver = true;
    session.row = {};
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

const records = guardRecords({ read: readRecords, write: writeRecords, remove: removeRecords, forget });

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
 * account with it) or to take one person's account and hourly rate off it (`drop`): the copies kept from before go
 * as soon as that save has settled (`forget`). Only on Android, where older copies are kept; the iPhone keeps one.
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
