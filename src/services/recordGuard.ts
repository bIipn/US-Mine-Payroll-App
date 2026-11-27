import type { StateStorage } from 'zustand/middleware';

/**
 * What every build puts around the place it keeps the store's records (storage.native.ts on a phone, storage.ts on
 * the web), so that both keep them the same way:
 *
 * - Nothing is written over the records, and nothing removes them, until the store has read them (`recordsRead`).
 *   A save made before then is an empty app's: the store saves as it opens, and again whenever anything changes,
 *   records that could not be read among them. Those stay where they are, and the store says so.
 * - A read that fails is not taken for a device with nothing saved: it fails. Once a read of a key has failed,
 *   nothing there is still a read that fails, until a read finds the records: the iPhone's AsyncStorage, when it
 *   cannot read a value's file, forgets the key, and asked again says there is nothing (storage.native.ts).
 * - Reads, saves and removals of a key happen one at a time, in the order asked. Each save holds everything, so a
 *   save that a later one stands in for is not done.
 * - A save that cannot be written (a full phone) is kept in memory and read back from there, and the next save
 *   tries the device again with all of it. Whether one is waiting is told to `watchUnsaved`, once when it starts
 *   and once when a save works again, so the app can say so on every screen.
 */

/** Where the records are kept, as a build reaches it: each of these throws when it does not work. */
export interface RecordPlace {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface GuardedRecords {
  /** The store's storage for its records. */
  recordStorage: StateStorage;
  /** The store has read what was saved under `key`, and its saves from now on are written to the device. */
  recordsRead(key: string): void;
  /**
   * Told `true` when a save of the records could not be written to the device and is held in memory, and `false`
   * once a save works again. Only when that changes. Returns the way to stop.
   */
  watchUnsaved(listener: (unsaved: boolean) => void): () => void;
}

export function guardRecords(place: RecordPlace): GuardedRecords {
  /** Keys whose records the store has read: only these are written to the device. */
  const opened = new Set<string>();
  /** Keys whose read has failed, until one finds the records: nothing read for these is a read that fails too. */
  const failed = new Set<string>();
  /** A save that could not be written to the device, by key: read back from here, and tried again by the next save. */
  const unsaved = new Map<string, string>();
  /** The last read, save or removal asked for, by key, each after the one before. */
  const turns = new Map<string, Promise<unknown>>();
  /** The latest save or removal asked for, by key: one that a later one stands in for is not done. */
  const latest = new Map<string, number>();
  let asked = 0;
  const listeners = new Set<(unsaved: boolean) => void>();
  let told = false;

  /** Tell the listeners whether a save is waiting, when that has changed. */
  const tell = () => {
    const now = unsaved.size > 0;
    if (now === told) return;
    told = now;
    for (const listener of [...listeners]) {
      try {
        listener(now);
      } catch {
        // A listener that fails does not stop the records being kept.
      }
    }
  };

  function inTurn<T>(key: string, job: () => Promise<T>): Promise<T> {
    const run = (turns.get(key) ?? Promise.resolve()).then(job);
    turns.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /** A save or a removal, in its turn, unless a later one was asked for meanwhile. */
  function change(key: string, job: () => Promise<void>): Promise<void> {
    // Not over records that have not been read: that would put an empty app's in their place.
    if (!opened.has(key)) return Promise.resolve();
    const mine = ++asked;
    latest.set(key, mine);
    return inTurn(key, async () => {
      if (latest.get(key) !== mine || !opened.has(key)) return;
      await job();
    });
  }

  const recordStorage: StateStorage = {
    getItem(key) {
      return inTurn(key, async () => {
        if (opened.has(key) && unsaved.has(key)) return unsaved.get(key)!;
        try {
          const saved = await place.read(key);
          if (saved === null && failed.has(key)) throw new Error('The records could not be read, and are not there now: they are not taken for none.');
          failed.delete(key);
          return saved;
        } catch (error) {
          opened.delete(key);
          failed.add(key);
          throw error;
        }
      });
    },
    setItem(key, value) {
      return change(key, async () => {
        try {
          await place.write(key, value);
          unsaved.delete(key);
        } catch {
          // Kept for this session; the next save tries the device again, with all of this in it.
          unsaved.set(key, value);
        }
        tell();
      });
    },
    removeItem(key) {
      return change(key, async () => {
        unsaved.delete(key);
        tell();
        try {
          await place.remove(key);
        } catch {
          // Left on the device.
        }
      });
    },
  };

  return {
    recordStorage,
    recordsRead: (key) => {
      opened.add(key);
    },
    watchUnsaved: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
