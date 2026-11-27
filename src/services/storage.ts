import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';

import { guardRecords } from './recordGuard';

/**
 * Device storage for the app state, on the web. iPhone and Android have their own, in storage.native.ts, which
 * keeps the store's records apart from everything else. If the platform storage is unavailable (a locked-down
 * browser frame, private mode), the app keeps working from memory for the session instead of crashing.
 *
 * The store's records are kept as a phone keeps them (recordGuard.ts): nothing is written over them until the
 * store has read them, so records that could not be read, or did not make sense, stay as they are and the app
 * says so; and a save the browser turns down (its storage is full) is said on every screen until one works.
 */
const memory = new Map<string, string>();
let broken = false;

export const safeStorage: StateStorage = {
  async getItem(key) {
    if (!broken) {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        broken = true;
      }
    }
    return memory.get(key) ?? null;
  },
  async setItem(key, value) {
    if (!broken) {
      try {
        await AsyncStorage.setItem(key, value);
        return;
      } catch {
        broken = true;
      }
    }
    memory.set(key, value);
  },
  async removeItem(key) {
    memory.delete(key);
    if (!broken) {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        broken = true;
      }
    }
  },
};

/**
 * Keys of records the browser would not let the app read: it does not let the app at its storage at all, so
 * nothing can have been saved there. They are kept in memory for the session, as everything is then, and a save
 * of them is never said to have failed.
 */
const recordsInMemory = new Set<string>();
const recordMemory = new Map<string, string>();

const records = guardRecords({
  async read(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      recordsInMemory.add(key);
      return recordMemory.get(key) ?? null;
    }
  },
  async write(key, value) {
    if (recordsInMemory.has(key)) {
      recordMemory.set(key, value);
      return;
    }
    // A full storage turns this down, and the save is held and said.
    await AsyncStorage.setItem(key, value);
  },
  async remove(key) {
    recordMemory.delete(key);
    if (!recordsInMemory.has(key)) await AsyncStorage.removeItem(key);
  },
});

/** Where the store keeps its records: in the browser's storage, beside everything else. */
export const recordStorage: StateStorage = records.recordStorage;

/** The store has read what was saved under `key`, and its saves from now on are written to the device. */
export const recordsRead = records.recordsRead;

/** Told whether a save of the records is waiting in memory because the browser turned it down (recordGuard.ts). */
export const watchUnsaved = records.watchUnsaved;

/**
 * Whether the last read of the records under `key` passed over a newer copy that was not whole, because the
 * device shut off while saving. Never in a browser: it keeps one copy, which it writes whole or not at all. A phone
 * keeps more (storage.native.ts).
 */
export function passedOverNewer(_key: string): boolean {
  return false;
}
