import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';

import type { Forgetting } from './recordCopies';
import { guardRecords } from './recordGuard';
import { recordsTab, type TabPlace } from './recordsTab';

/**
 * Device storage for the app state, on the web. iPhone and Android have their own, in storage.native.ts, which
 * keeps the store's records apart from everything else. If the platform storage is unavailable (a locked-down
 * browser frame, private mode), the app keeps working from memory for the session instead of crashing.
 *
 * The store's records are kept as a phone keeps them (recordGuard.ts): nothing is written over them until the
 * store has read them, so records that could not be read, or did not make sense, stay as they are and the app
 * says so; and a save the browser turns down is said on every screen until one works. Once the records have been
 * read, a browser turns a save down when its room for this site is full (QuotaExceededError, the one error setItem
 * throws): that room is fixed, about 5 MB, whatever room the computer has, so the app says so in a browser's words
 * and tries again less often (RecordsNotSaved.tsx).
 *
 * Every tab of MineMuster in a browser shares that storage, and each saves all of the store on every change, so one
 * tab at a time saves the records (recordsTab.ts): the tab that has them. Another tab saves nothing and says so over
 * every screen (`recordsElsewhere`, RecordsNotSavedFrame), until it takes them (`takeRecords`) or the tab that had
 * them closes; then it reads them again before it saves (`watchOtherTabs`), since the other tab may have saved since.
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
 * Keys of records the browser would not let the app read: it does not let the app at its storage at all (blocked
 * storage, a sandboxed frame, a corrupted store), so nothing can have been saved there. They are kept in memory for
 * the session, as everything is then. A save of them is never said to have failed; that they are only in memory is
 * (`keptInMemory`), since they go when the tab closes.
 */
const recordsInMemory = new Set<string>();
const recordMemory = new Map<string, string>();

/** The browser's lock manager, as this tab has it when it opens: only in a secure context (https, or localhost). */
function lockManager(): TabPlace['locks'] {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Partial<Navigator>).locks ?? undefined;
}

/** How this tab hears of another tab's save: the 'storage' event, which the browser sends every other tab of the site. */
function storageEvents(): TabPlace['watchSaves'] {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
  const listen = window.addEventListener.bind(window);
  const stop = window.removeEventListener.bind(window);
  return (key, heard) => {
    const listener = (event: StorageEvent) => {
      if (event.key === key) heard();
    };
    listen('storage', listener);
    return () => stop('storage', listener);
  };
}

/** Told when another tab takes the records (`false`), and when this one has them again and is to read them (`true`). */
const otherTabListeners = new Set<(key: string, here: boolean) => Promise<void> | void>();

const tabs = recordsTab({
  locks: lockManager(),
  watchSaves: storageEvents(),
  changed: async (key, here) => {
    // From now on nothing this tab has in memory is written over what the other tab saves.
    if (!here) records.letGo(key);
    await Promise.all(
      [...otherTabListeners].map(async (listener) => {
        try {
          await listener(key, here);
        } catch {
          // A listener that fails does not stop the others being told.
        }
      }),
    );
  },
});

const records = guardRecords({
  async read(key) {
    // Whether this tab has them is known before they are read, so that it reads what no other tab is writing over.
    await tabs.asked(key);
    tabs.reading(key);
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      // Only in this tab's memory: no other tab shares them, so this one saves them, whatever the others do.
      recordsInMemory.add(key);
      tabs.alone(key);
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

/**
 * The store has read what was saved under `key`, and its saves from now on are written to the device: when this tab
 * has the records, and read them while it had them. Otherwise it saves nothing (`inAnotherTab`).
 */
export function recordsRead(key: string): void {
  if (tabs.mayWrite(key)) records.recordsRead(key);
}

/**
 * Whether this tab saves nothing of the records under `key`, because another tab of the browser has them, or had
 * them when they were read. The store says so over every screen (`recordsElsewhere`). Never on a phone.
 */
export function inAnotherTab(key: string): boolean {
  return !tabs.mayWrite(key);
}

/**
 * Told when another tab of the browser takes the records (`false`: this one saves nothing more), and when this one
 * has them again (`true`): it is to read them again before it saves, since the other tab may have saved since. The
 * store does (persist.rehydrate), and `takeRecords` waits for what this returns. Returns the way to stop.
 */
export function watchOtherTabs(listener: (key: string, here: boolean) => Promise<void> | void): () => void {
  otherTabListeners.add(listener);
  return () => {
    otherTabListeners.delete(listener);
  };
}

/**
 * Take the records under `key` for this tab, from whichever tab has them (Use this tab): from then on this one saves
 * them and the other saves nothing. Resolves once the store has read them again.
 */
export function takeRecords(key: string): Promise<void> {
  return tabs.take(key);
}

/** Told whether a save of the records is waiting in memory because the browser turned it down (recordGuard.ts). */
export const watchUnsaved = records.watchUnsaved;

/**
 * Whether the records under `key` are kept only in memory for this session, because the browser would not let the
 * app at its storage when they were read: what is done is lost when the tab closes, unless it was sent. The store
 * says so over every screen in a build that keeps real records (`recordsInMemory`); the preview, which runs inside
 * a frame, expects it. Never on a phone (storage.native.ts).
 */
export function keptInMemory(key: string): boolean {
  return recordsInMemory.has(key);
}

/**
 * Whether the last read of the records under `key` passed over a newer copy that was not whole, because the
 * device shut off while saving. Never in a browser: it keeps one copy, which it writes whole or not at all. A phone
 * keeps more (storage.native.ts).
 */
export function passedOverNewer(_key: string): boolean {
  return false;
}

/**
 * Before the store saves to empty the device, or to take one person's records off it, older copies of the records
 * are let go of (storage.native.ts). Nothing to do in a browser: it keeps one copy, and that save replaces it.
 */
export function forgetCopies(_key: string, _how: Forgetting): void {
  // One copy, which the save that follows replaces.
}
