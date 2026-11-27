import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type { StateStorage } from 'zustand/middleware';

import { checkpointDue, checkpointName, checkpointOrder, isSettled, newestFirst, nextOrder, toLetGo, type Checkpoint } from './recordCopies';
import { guardRecords } from './recordGuard';

/**
 * Device storage on iPhone and Android. storage.ts is the web's, and holds the shared types.
 *
 * The store's records (`recordStorage`) are one value that grows with every punch, checklist, exam and request,
 * and none of it is ever pruned. On Android they are kept in a file of their own, in the app's private files:
 * AsyncStorage keeps a value in one SQLite row, and Android cannot hand back a row over about 2 MB (it must fit
 * one CursorWindow), which a phone's records pass in months. A phone that kept them in AsyncStorage under an
 * older version has them moved into the file the first time they are read; the row stays until a later start reads
 * the file whole and it has had time to reach the disk. On the iPhone they stay in AsyncStorage, where they have
 * always been: it keeps a large value in a file of its own, with no such limit, in a folder left out of the phone's
 * backups, where a file in the app's documents would go into them.
 *
 * Nothing is written over the records until the store has read them (`recordsRead`). A save made before then is
 * an empty phone's, and a phone whose records could not be read keeps them where they are; the store says so,
 * instead of opening as a new phone. A save that cannot be written (a full phone) is held in memory and said on
 * every screen until one works (`watchUnsaved`). Both are recordGuard.ts, which the web's storage uses too.
 *
 * On Android a save cannot make what it writes reach the disk before the app goes on (recordCopies.ts), so a
 * power cut can tear what was written in the last half a minute or so. A copy is read only if it is whole JSON, and
 * the file is kept aside now and then as a checkpoint, so that a whole copy that has had time to reach the disk is
 * always there. When a newer copy was torn and an older one was read, the store is told (`passedOverNewer`) and
 * the app says so once.
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
 * earlier build of this version kept (`.prev`), read as the oldest checkpoint.
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

/** When what a file holds was written (its modificationTime, which a rename keeps), or null when the phone cannot say. */
function writtenAt(name: string): number | null {
  try {
    const info = at(name).info();
    return info.exists && typeof info.modificationTime === 'number' ? info.modificationTime : null;
  } catch {
    return null;
  }
}

/**
 * Checkpoints this session knows to be whole, by key: the one it read, and the ones it made from the file, which
 * by then it has always read whole or written itself (`settle`). One left from before may have been torn.
 */
const known = new Map<string, Set<string>>();
function knownOf(key: string): Set<string> {
  let names = known.get(key);
  if (!names) known.set(key, (names = new Set()));
  return names;
}

/** When this session last kept the file aside as a checkpoint, by key. */
const madeAt = new Map<string, number>();

/** The checkpoints of `key` in the app's files, newest first. Throws when the files cannot be listed. */
function checkpointsOf(key: string): Checkpoint[] {
  const mine = knownOf(key);
  const found: Checkpoint[] = [];
  for (const entry of Paths.document.list()) {
    const order = checkpointOrder(key, entry.name);
    if (order === null) continue;
    found.push({ name: entry.name, order, writtenAt: writtenAt(entry.name), known: mine.has(entry.name) });
  }
  return newestFirst(found);
}

/** Where the store's records were read from, by key, until the next save has put that in place (`settle`). */
type ReadFrom = { copy: 'next' } | { copy: 'kept' } | { copy: 'row' } | { copy: 'checkpoint'; order: number };
const readFrom = new Map<string, ReadFrom>();

/** What the newest readable copy of the records holds. */
interface Found {
  text: string;
  /** Whether it is whole JSON. With no copy whole, the newest is handed back as it is. */
  whole: boolean;
  /** When it was written, or null when the phone cannot say. */
  writtenAt: number | null;
  /** Whether a newer copy was there, was not whole, and was passed over for this one. */
  passedOver: boolean;
}

/**
 * The records in the files, or null with none: the newest copy that is whole, read newest first: the new copy
 * beside the file (a save writes it whole before it takes the file's place), the file, then the checkpoints,
 * newest first. Never a copy still being written (`part`). A copy that cannot be read at all fails the read: it is
 * not passed over, since what is in it may be the newest. With no copy whole, the newest is handed back as it is,
 * and the store, which cannot read it either, says so.
 */
async function readFile(key: string): Promise<Found | null> {
  const names = namesOf(key);
  let newest: Found | null = null;
  const look = async (name: string, from: ReadFrom): Promise<Found | null> => {
    const text = await at(name).text();
    if (whole(text)) {
      readFrom.set(key, from);
      return { text, whole: true, writtenAt: writtenAt(name), passedOver: newest !== null };
    }
    newest ??= { text, whole: false, writtenAt: writtenAt(name), passedOver: false };
    return null;
  };
  for (const copy of ['next', 'kept'] as const) {
    if (!at(names[copy]).exists) continue;
    const found = await look(names[copy], { copy });
    if (found) return found;
  }
  for (const checkpoint of checkpointsOf(key)) {
    const found = await look(checkpoint.name, { copy: 'checkpoint', order: checkpoint.order });
    if (found) {
      knownOf(key).add(checkpoint.name);
      return found;
    }
  }
  return newest;
}

/**
 * Before the first save after a read, put what was read in place, and take away every copy newer than it, which
 * were torn: so that none of them is ever kept aside as a checkpoint, or taken for a whole copy settled on the
 * disk and let an older whole one go. Done again until it works.
 */
async function settle(key: string): Promise<void> {
  const from = readFrom.get(key);
  if (!from) return;
  const names = namesOf(key);
  if (from.copy === 'next') {
    // The newest copy was whole beside the file: it takes the file's place, whatever the file holds.
    await at(names.next).move(at(names.kept), { overwrite: true });
  } else if (from.copy === 'kept') {
    if (at(names.next).exists) at(names.next).delete();
  } else {
    // Read from a checkpoint, or from an older version's row: every copy of the files newer than it is torn.
    if (at(names.next).exists) at(names.next).delete();
    if (at(names.kept).exists) at(names.kept).delete();
    for (const checkpoint of checkpointsOf(key)) {
      if (from.copy === 'row' || checkpoint.order > from.order) at(checkpoint.name).delete();
    }
  }
  readFrom.delete(key);
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
  await settle(key);
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
  await at(names.part).move(at(names.next), { overwrite: true });

  const now = Date.now();
  let checkpoints: Checkpoint[] | null = null;
  try {
    checkpoints = checkpointsOf(key);
  } catch {
    // Not listed this time: the file is replaced as between checkpoints, and none is let go.
  }
  if (checkpoints && at(names.kept).exists && checkpointDue(checkpoints, now, madeAt.get(key))) {
    const order = nextOrder(checkpoints, now);
    const name = checkpointName(key, order);
    const when = writtenAt(names.kept);
    try {
      at(names.kept).rename(name);
      knownOf(key).add(name);
      madeAt.set(key, now);
      checkpoints = [...checkpoints, { name, order, writtenAt: when, known: true }];
    } catch {
      // Not kept aside this time: the move below replaces the file, as between checkpoints.
    }
  }
  await at(names.next).move(at(names.kept), { overwrite: true });

  for (const old of checkpoints ? toLetGo(checkpoints, now) : []) {
    try {
      at(old.name).delete();
      knownOf(key).delete(old.name);
    } catch {
      // Let go at the next save.
    }
  }
}

async function removeFile(key: string): Promise<void> {
  readFrom.delete(key);
  known.delete(key);
  madeAt.delete(key);
  const names = namesOf(key);
  for (const name of [names.next, names.kept, names.part]) if (at(name).exists) at(name).delete();
  for (const checkpoint of checkpointsOf(key)) at(checkpoint.name).delete();
}

/**
 * Move an older version's row into the file. The row is not removed now: what was just written may not have
 * reached the disk, and a power cut in the next minute could leave it torn. It goes at a later start, once the file
 * is read whole there and has had time to reach the disk (`dropMovedRow`). A copy that does not read back the same
 * is not left to be read in the row's place.
 */
async function moveRow(key: string, row: string): Promise<void> {
  let same = false;
  try {
    await writeFile(key, row);
    same = (await readFile(key))?.text === row;
  } catch {
    same = false;
  }
  if (same) return;
  try {
    await removeFile(key);
  } catch {
    // Nothing more to do: the next start reads what is there.
  }
}

/**
 * At a start, remove the row an older version left, once the file it was moved into has been read whole and is
 * settled on the disk (written two minutes ago or more): the file holds all of it, and more.
 */
async function dropMovedRow(key: string, found: Found): Promise<void> {
  if (!isSettled(found, Date.now())) return;
  try {
    if ((await AsyncStorage.getAllKeys()).includes(key)) await AsyncStorage.removeItem(key);
  } catch {
    // The next start tries again.
  }
}

// ---- The records, in AsyncStorage (iPhone) -------------------------------------------------

/**
 * On the iPhone, the mark that records are kept under a key: a few bytes, held in AsyncStorage's manifest, there
 * from the first save that works or the first read that finds them, and taken off only with the records.
 *
 * RNCAsyncStorage keeps a large value in a file of its own and lists its key in a manifest, which it reads from the
 * disk when the app starts. When it cannot read a value's file, it takes the key off the manifest it holds and
 * fails; asked again it says there is nothing, and its next change of any key writes that manifest to the disk, so
 * that even opened again the app would be told there is nothing. Without the mark either would open as a new phone,
 * and its first save would put an empty phone's records over that file.
 *
 * A read that fails writes nothing when the mark is there: a write would put the manifest on the disk without the
 * records' key, and opening MineMuster again (a new RNCAsyncStorage, reading the manifest from the disk) may read
 * them. Only a phone whose records were saved before there was a mark has one written then: never opening over its
 * records counts for more than a second chance at reading them.
 */
const markOf = (key: string) => `${key}:on-this-phone`;
/** Keys whose mark this session knows is there. */
const marked = new Set<string>();

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
  let saved: string | null;
  try {
    saved = await AsyncStorage.getItem(key);
  } catch (error) {
    await markKept(key);
    throw error;
  }
  if (saved !== null) {
    await markKept(key);
    return saved;
  }
  // Nothing there. On a phone that has kept records here, that is AsyncStorage having lost track of them.
  if ((await AsyncStorage.getItem(markOf(key))) !== null) throw new Error('The records on this phone could not be found where they are kept.');
  return null;
}

// ---- The records ---------------------------------------------------------------------------

/** Whether the last read of a key passed over a newer copy of the records that was there and was not whole. */
const passedOver = new Map<string, boolean>();

async function readRecords(key: string): Promise<string | null> {
  if (!IN_FILE) return readRow(key);
  passedOver.delete(key);
  const found = await readFile(key);
  if (found?.whole) {
    passedOver.set(key, found.passedOver);
    await dropMovedRow(key, found);
    return found.text;
  }
  // Kept in AsyncStorage by an older version of the app. A row too big to hand back fails here, and is left there.
  const row = await AsyncStorage.getItem(key);
  if (row === null) return found?.text ?? null;
  if (found) {
    // Files are there, but none is whole: a power cut soon after the row was moved tore what was written since.
    // The row is read; the torn files go at the first save (`settle`), and the row stays until a later start.
    readFrom.set(key, { copy: 'row' });
    passedOver.set(key, true);
    return row;
  }
  await moveRow(key, row);
  return row;
}

async function writeRecords(key: string, value: string): Promise<void> {
  if (!IN_FILE) {
    await AsyncStorage.setItem(key, value);
    await markKept(key);
    return;
  }
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
}

const records = guardRecords({ read: readRecords, write: writeRecords, remove: removeRecords });

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
 * Whether the last read of the records under `key` passed over a newer copy that was there and was not whole:
 * the phone shut off while saving (a power cut, a forced restart), and the last changes before that may not be on
 * it. Only on Android, where the records are a file; never saved itself.
 */
export function passedOverNewer(key: string): boolean {
  return passedOver.get(key) ?? false;
}

/**
 * Whether the records under `key` are kept only in memory for this session. Never on a phone: a read that fails
 * here fails, and the app says the records could not be read. Only a browser that will not let the app at its
 * storage keeps them in memory (storage.ts).
 */
export function keptInMemory(_key: string): boolean {
  return false;
}
