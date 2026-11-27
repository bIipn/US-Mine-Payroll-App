/**
 * Which tab of a browser saves the store's records (storage.ts, the web's). Every tab of MineMuster in one browser
 * reads and writes the same storage, but each keeps all of the store in its own memory and saves all of it on every
 * change: two tabs saving would each write over what the other saved, and a punch made in one would be gone from the
 * browser and never sent from it. So one tab at a time saves them.
 *
 * - Where the browser has Web Locks (navigator.locks, in a secure context), the tab that saves holds an exclusive
 *   lock named for the records' key, from the first time it reads them until it closes. A tab opened while another
 *   holds it saves nothing, and waits for it: once that tab closes, it has them. It can also take them at once
 *   (`take`, a steal); the tab they were taken from learns it, its request ending with an AbortError, and saves
 *   nothing more until it takes them back or the other closes.
 * - Where it has none, or its lock manager turns the request down (an opaque origin, a sandboxed frame) or does not
 *   answer, every tab saves until another tab's save of the records reaches it (the 'storage' event a browser sends
 *   every other tab of the site): from then on it saves nothing, until it takes them back.
 * - A tab that has them after another had them saves nothing until it has read them again (`mayWrite`): what it
 *   has in memory may be older than what the other tab saved. It is told (`changed`), and the store reads them.
 * - Records the browser will not let the app at its storage are only in this tab's memory (`alone`): no other tab
 *   shares them, so this one always saves them, and lets go of the lock.
 *
 * Which tab has them is known before they are read the first time (`asked`), so that a tab that has them reads what
 * no other tab is writing over. Nothing here is saved: a new tab starts by asking.
 */

/** What a browser gives the app to tell its tabs apart. */
export interface TabPlace {
  /** The browser's lock manager (navigator.locks), when it has one. */
  locks?: Pick<LockManager, 'request'>;
  /** Listen for another tab of the browser saving under `key` (the 'storage' event). Returns the way to stop. */
  watchSaves?(key: string, heard: () => void): () => void;
  /** How long the first answer about the lock is waited for, before the tab saves anyway. */
  answerMs?: number;
  /**
   * Told, after the first answer, each time this tab has the records of `key` again (`true`: it reads them again
   * before it saves) or another tab has taken them (`false`). What it returns is waited for by `take`.
   */
  changed(key: string, here: boolean): Promise<void> | void;
}

export interface RecordsTab {
  /** Resolves once this tab knows whether it has the records of `key`: the first time, it starts asking. */
  asked(key: string): Promise<void>;
  /** The records of `key` are being read now. */
  reading(key: string): void;
  /** Whether this tab saves the records of `key`: it has them, and has read them since it had them. */
  mayWrite(key: string): boolean;
  /** Take the records of `key` from whichever tab has them. Resolves once this tab has them and was told so. */
  take(key: string): Promise<void>;
  /** The records of `key` are kept in this tab's memory alone: it saves them, whatever other tabs do. */
  alone(key: string): void;
}

/** How long a lock manager has to say whether the lock is free, before the tab saves anyway (it answers at once). */
export const ANSWER_MS = 3000;

interface Claim {
  /** Whether this tab has the records: it alone saves them. */
  held: boolean;
  /** Counts each time this tab had them or lost them. */
  turn: number;
  /** The turn they were last read in, while this tab had them; null when read while it did not. */
  readIn: number | null;
  /** Whether the first answer came. Nothing is told before it. */
  answered: boolean;
  first: Promise<void>;
  answer: () => void;
  /** No answer from the lock manager yet, and the time it has left. */
  timer?: ReturnType<typeof setTimeout>;
  /** What says another tab has them: the lock, or another tab's save. */
  by: 'lock' | 'saves';
  /** Lets go of the lock this tab holds. */
  release?: () => void;
  /** Calls off the request waiting for the lock. */
  waiting?: AbortController;
  /** Stops listening for other tabs' saves. */
  unwatch?: () => void;
  /** Kept in this tab's memory alone (`alone`). */
  apart: boolean;
}

const isAbort = (error: unknown) => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

export function recordsTab(place: TabPlace): RecordsTab {
  const claims = new Map<string, Claim>();

  function settle(claim: Claim): void {
    if (claim.answered) return;
    claim.answered = true;
    clearTimeout(claim.timer);
    claim.timer = undefined;
    claim.answer();
  }

  /** Tell what changed, once the first answer has come. */
  function report(key: string, claim: Claim): Promise<void> {
    if (!claim.answered) {
      settle(claim);
      return Promise.resolve();
    }
    try {
      return Promise.resolve(place.changed(key, claim.held)).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  /** This tab has the records now. Resolves once it has been told. */
  function gained(key: string, claim: Claim): Promise<void> {
    if (claim.apart) return Promise.resolve();
    if (claim.held) {
      settle(claim);
      return Promise.resolve();
    }
    claim.held = true;
    claim.turn += 1;
    return report(key, claim);
  }

  /** Another tab has the records now. */
  function lost(key: string, claim: Claim): void {
    if (claim.apart) return;
    if (!claim.held) {
      settle(claim);
      return;
    }
    claim.held = false;
    claim.turn += 1;
    void report(key, claim);
  }

  /** Go by other tabs' saves: the lock manager is not there, turned the request down, or did not answer. */
  function bySaves(key: string, claim: Claim): void {
    if (claim.answered || claim.apart) return;
    claim.by = 'saves';
    if (!claim.unwatch && place.watchSaves) {
      claim.unwatch = place.watchSaves(key, () => {
        if (claim.by === 'saves') lost(key, claim);
      });
    }
    void gained(key, claim);
  }

  /** The lock manager answered: it is what says which tab has the records from now on. */
  function byLock(claim: Claim): void {
    claim.by = 'lock';
    claim.unwatch?.();
    claim.unwatch = undefined;
  }

  interface Asked {
    /** The lock is not free (asked with `ifAvailable`). */
    unavailable?(): void;
    /** This tab has the lock; `told` resolves once it has been told. */
    granted?(told: Promise<void>): void;
    /** The request ended before it had the lock, and not because this tab called it off. */
    refused?(error: unknown): void;
  }

  /** Ask the lock manager for the lock of `key`, held until the tab closes or another takes it. */
  function ask(key: string, claim: Claim, options: LockOptions, then: Asked): void {
    const { locks } = place;
    if (!locks) {
      then.refused?.(new Error('No lock manager.'));
      return;
    }
    let had = false;
    let mine: (() => void) | undefined;
    let request: Promise<unknown>;
    try {
      request = locks.request(key, options, (lock) => {
        if (claim.apart) return undefined;
        if (!lock) {
          then.unavailable?.();
          return undefined;
        }
        had = true;
        byLock(claim);
        return new Promise<void>((resolve) => {
          mine = resolve;
          claim.release = resolve;
          const told = gained(key, claim);
          then.granted?.(told);
        });
      });
    } catch (error) {
      then.refused?.(error);
      return;
    }
    request.then(undefined, (error: unknown) => {
      // Whether this request is the one this tab holds the records by: a later one of its own may have taken over.
      const holding = mine !== undefined && claim.release === mine;
      if (holding) claim.release = undefined;
      mine?.();
      if (had) {
        // Another tab took the lock (an AbortError): this one has the records no more, and waits to have them again.
        if (holding && isAbort(error)) {
          lost(key, claim);
          wait(key, claim);
        }
        return;
      }
      if (options.signal?.aborted) return;
      then.refused?.(error);
    });
  }

  /** Wait in turn for the lock, while another tab has it. */
  function wait(key: string, claim: Claim): void {
    if (claim.waiting || claim.apart || claim.by !== 'lock') return;
    const waiting = new AbortController();
    claim.waiting = waiting;
    const done = () => {
      if (claim.waiting === waiting) claim.waiting = undefined;
    };
    ask(key, claim, { mode: 'exclusive', signal: waiting.signal }, { granted: done, refused: done });
  }

  function start(key: string, claim: Claim): void {
    if (!place.locks) {
      bySaves(key, claim);
      return;
    }
    claim.timer = setTimeout(() => bySaves(key, claim), place.answerMs ?? ANSWER_MS);
    ask(
      key,
      claim,
      { mode: 'exclusive', ifAvailable: true },
      {
        unavailable: () => {
          byLock(claim);
          lost(key, claim);
          wait(key, claim);
        },
        refused: () => bySaves(key, claim),
      },
    );
  }

  function claimOf(key: string): Claim {
    let claim = claims.get(key);
    if (claim) return claim;
    let answer: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (answer = resolve));
    claim = { held: false, turn: 0, readIn: null, answered: false, first, answer, by: 'lock', apart: false };
    claims.set(key, claim);
    start(key, claim);
    return claim;
  }

  return {
    asked: (key) => claimOf(key).first,
    reading: (key) => {
      const claim = claims.get(key);
      if (claim) claim.readIn = claim.held ? claim.turn : null;
    },
    mayWrite: (key) => {
      const claim = claims.get(key);
      return !!claim && claim.held && claim.readIn === claim.turn;
    },
    take: (key) => {
      const claim = claimOf(key);
      if (claim.apart) return Promise.resolve();
      if (claim.held) {
        // Read while another tab had them: told again, so the store reads them again.
        return claim.readIn === claim.turn ? Promise.resolve() : report(key, claim);
      }
      if (claim.by === 'saves' || !place.locks) return gained(key, claim);
      // The request waiting in turn is called off: this one takes the lock at once.
      claim.waiting?.abort();
      claim.waiting = undefined;
      return new Promise<void>((resolve) => {
        ask(key, claim, { mode: 'exclusive', steal: true }, { granted: (told) => void told.then(resolve), refused: () => resolve() });
      });
    },
    alone: (key) => {
      const claim = claimOf(key);
      claim.apart = true;
      claim.held = true;
      claim.readIn = claim.turn;
      claim.waiting?.abort();
      claim.waiting = undefined;
      claim.release?.();
      claim.release = undefined;
      claim.unwatch?.();
      claim.unwatch = undefined;
      settle(claim);
    },
  };
}
