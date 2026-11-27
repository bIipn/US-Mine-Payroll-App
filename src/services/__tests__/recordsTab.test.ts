/**
 * Which tab of a browser saves the store's records (recordsTab.ts). Every tab of MineMuster in a browser shares one
 * storage and saves all of the store on every change, so one tab at a time saves them: the one holding a Web Lock
 * named for their key, or, in a browser with no Web Locks, every tab until another tab's save of them reaches it. A
 * tab that has them again saves nothing until it has read them again.
 *
 * The browser is made up here: its lock manager is src/testing/fakeLocks.ts, and the 'storage' event a save sends the other
 * tabs is a list of listeners.
 */
import { recordsTab, type RecordsTab } from '../recordsTab';
import { FakeLocks } from '../../testing/fakeLocks';

const KEY = 'us-mine-crew-records';

/** Let every request, grant and answer under way finish. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What one tab hears of another tab's save: the browser's 'storage' event, by tab. */
class Saves {
  private heard = new Map<string, Set<{ key: string; heard: () => void }>>();
  watcher(tab: string) {
    return (key: string, heard: () => void) => {
      const mine = this.heard.get(tab) ?? new Set();
      this.heard.set(tab, mine);
      const entry = { key, heard };
      mine.add(entry);
      return () => {
        mine.delete(entry);
      };
    };
  }
  /** A tab saved this key: every other tab hears it. */
  saved(by: string, key: string) {
    for (const [tab, entries] of this.heard) {
      if (tab === by) continue;
      for (const entry of entries) if (entry.key === key) entry.heard();
    }
  }
}

interface Tab {
  t: RecordsTab;
  /** What the tab was told after the first answer: true when it has the records again, false when another took them. */
  told: boolean[];
}

function open(name: string, browser: { locks?: Pick<LockManager, 'request'>; saves?: Saves; answerMs?: number }, changed?: () => Promise<void>): Tab {
  const told: boolean[] = [];
  const t = recordsTab({
    locks: browser.locks,
    watchSaves: browser.saves?.watcher(name),
    answerMs: browser.answerMs,
    changed: (key, here) => {
      expect(key).toBe(KEY);
      told.push(here);
      return changed?.();
    },
  });
  return { t, told };
}

/** The tab reads the records, as the store does once it knows whether this tab has them. */
async function reads(tab: Tab): Promise<void> {
  await tab.t.asked(KEY);
  tab.t.reading(KEY);
}

describe('with Web Locks', () => {
  it('the tab that reads them first has them; one opened while it does saves nothing', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    expect(a.t.mayWrite(KEY)).toBe(true);
    expect(locks.holder(KEY)).toBe('A');

    const b = open('B', { locks: locks.client('B') });
    await reads(b);
    expect(b.t.mayWrite(KEY)).toBe(false);
    expect(a.t.mayWrite(KEY)).toBe(true);
    // The first answer is not told: the store asks for it once it has read them (mayWrite).
    expect(a.told).toEqual([]);
    expect(b.told).toEqual([]);
  });

  it('a tab takes them at once; the tab it took them from learns it, and saves nothing more', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    const b = open('B', { locks: locks.client('B') });
    await reads(b);

    await b.t.take(KEY);
    expect(b.told).toEqual([true]);
    expect(locks.holder(KEY)).toBe('B');
    // What it has in memory was read while A had them: it saves nothing until it has read them again.
    expect(b.t.mayWrite(KEY)).toBe(false);
    b.t.reading(KEY);
    expect(b.t.mayWrite(KEY)).toBe(true);

    await flush();
    expect(a.told).toEqual([false]);
    expect(a.t.mayWrite(KEY)).toBe(false);
    // Reading them does not give them back.
    a.t.reading(KEY);
    expect(a.t.mayWrite(KEY)).toBe(false);
  });

  it('the tab waiting has them by itself once the tab that has them closes, and reads them again before it saves', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    const b = open('B', { locks: locks.client('B') });
    await reads(b);

    locks.close('A');
    await flush();
    expect(locks.holder(KEY)).toBe('B');
    expect(b.told).toEqual([true]);
    expect(b.t.mayWrite(KEY)).toBe(false);
    b.t.reading(KEY);
    expect(b.t.mayWrite(KEY)).toBe(true);
  });

  it('a tab they were taken from has them again once the tab that took them closes', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    const b = open('B', { locks: locks.client('B') });
    await reads(b);
    await b.t.take(KEY);
    await flush();
    expect(a.told).toEqual([false]);

    locks.close('B');
    await flush();
    expect(locks.holder(KEY)).toBe('A');
    expect(a.told).toEqual([false, true]);
    a.t.reading(KEY);
    expect(a.t.mayWrite(KEY)).toBe(true);
  });

  it('take ends once the tab has done what it does with them: it reads them again', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    let readAgain: () => void = () => undefined;
    const b = open('B', { locks: locks.client('B') }, () => new Promise<void>((resolve) => (readAgain = resolve)));
    await reads(b);

    let taken = false;
    const taking = b.t.take(KEY).then(() => (taken = true));
    await flush();
    expect(b.told).toEqual([true]);
    expect(taken).toBe(false);
    readAgain();
    await taking;
    expect(taken).toBe(true);
  });

  it('a tab that has them and has read them since takes nothing from anyone', async () => {
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    await a.t.take(KEY);
    expect(a.told).toEqual([]);
    expect(a.t.mayWrite(KEY)).toBe(true);
  });

  it('a lock manager that does not answer: after a while the tab saves anyway, and goes by other tabs’ saves', async () => {
    const locks = new FakeLocks();
    locks.hangs = true;
    const saves = new Saves();
    const a = open('A', { locks: locks.client('A'), saves, answerMs: 20 });
    await reads(a);
    expect(a.t.mayWrite(KEY)).toBe(true);
    saves.saved('B', KEY);
    expect(a.told).toEqual([false]);
    expect(a.t.mayWrite(KEY)).toBe(false);
  });

  it('a lock manager that turns the request down (a sandboxed frame): the tab saves, and goes by other tabs’ saves', async () => {
    const refused = { request: () => Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')) } as unknown as Pick<LockManager, 'request'>;
    const saves = new Saves();
    const a = open('A', { locks: refused, saves });
    await reads(a);
    expect(a.t.mayWrite(KEY)).toBe(true);
    saves.saved('B', KEY);
    expect(a.t.mayWrite(KEY)).toBe(false);
  });

  it('records this tab keeps in its memory alone: it always saves them, and lets go of the lock', async () => {
    // A browser that will not let the app at its storage: no tab shares the records, so none waits on another.
    const locks = new FakeLocks();
    const a = open('A', { locks: locks.client('A') });
    await reads(a);
    const b = open('B', { locks: locks.client('B') });
    await b.t.asked(KEY);
    b.t.reading(KEY);
    b.t.alone(KEY);
    expect(b.t.mayWrite(KEY)).toBe(true);

    a.t.alone(KEY);
    await flush();
    expect(a.t.mayWrite(KEY)).toBe(true);
    expect(locks.holder(KEY)).toBeNull();
    expect(a.told).toEqual([]);
    expect(b.told).toEqual([]);
  });
});

describe('with no Web Locks (a page served over plain http, an older browser)', () => {
  it('every tab saves until another tab’s save of the records reaches it; then it saves nothing until it takes them back', async () => {
    const saves = new Saves();
    const a = open('A', { saves });
    const b = open('B', { saves });
    await reads(a);
    await reads(b);
    expect(a.t.mayWrite(KEY)).toBe(true);
    expect(b.t.mayWrite(KEY)).toBe(true);

    saves.saved('A', KEY);
    expect(b.told).toEqual([false]);
    expect(b.t.mayWrite(KEY)).toBe(false);
    expect(a.t.mayWrite(KEY)).toBe(true);
    // Another key's save is not the records'.
    saves.saved('A', 'minemuster-server-session');
    expect(b.told).toEqual([false]);

    await b.t.take(KEY);
    expect(b.told).toEqual([false, true]);
    expect(b.t.mayWrite(KEY)).toBe(false);
    b.t.reading(KEY);
    expect(b.t.mayWrite(KEY)).toBe(true);

    saves.saved('B', KEY);
    expect(a.told).toEqual([false]);
    expect(a.t.mayWrite(KEY)).toBe(false);
  });

  it('with no way to hear another tab either, the tab saves, as it always has', async () => {
    const a = open('A', {});
    await reads(a);
    expect(a.t.mayWrite(KEY)).toBe(true);
  });
});
