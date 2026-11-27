/**
 * What every build puts around the place it keeps the store's records (recordGuard.ts). Here, the rule that a read
 * that failed is not followed by a new phone: once reading the records under a key has thrown, nothing there (a
 * null read) is still a read that fails, until a read finds them. The iPhone's AsyncStorage needs it: when it
 * cannot read a value's file it forgets the key, and asked again it says there is nothing (storage.native.test.ts).
 */
import { guardRecords, type RecordPlace } from '../recordGuard';

const KEY = 'us-mine-crew-records';

/** A place whose reads answer, in turn, with these: a value, null, or an error to throw. */
function place(answers: (string | null | Error)[]) {
  const written: string[] = [];
  const at: RecordPlace = {
    async read() {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    async write(_key, value) {
      written.push(value);
    },
    async remove() {
      written.push('(removed)');
    },
  };
  return { at, written };
}

it('a read that failed, then nothing there, is still a read that fails, and nothing is written', async () => {
  const { at, written } = place([new Error('Failed to read storage file.'), null, null]);
  const guarded = guardRecords(at);
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow('Failed to read storage file.');
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow();
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow();
  await guarded.recordStorage.setItem(KEY, 'an empty phone');
  expect(written).toEqual([]);
});

it('opens once a read finds the records, and only then', async () => {
  const { at, written } = place([new Error('read failed'), null, 'saved']);
  const guarded = guardRecords(at);
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow();
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow();
  expect(await guarded.recordStorage.getItem(KEY)).toBe('saved');
  guarded.recordsRead(KEY);
  await guarded.recordStorage.setItem(KEY, 'saved and more');
  expect(written).toEqual(['saved and more']);
});

it('a phone that never failed to read, with nothing there, is a new phone', async () => {
  const { at } = place([null]);
  expect(await guardRecords(at).recordStorage.getItem(KEY)).toBeNull();
});

it('is kept for each key apart', async () => {
  const { at } = place([new Error('read failed'), null]);
  const guarded = guardRecords(at);
  await expect(guarded.recordStorage.getItem(KEY)).rejects.toThrow();
  expect(await guarded.recordStorage.getItem('another-key')).toBeNull();
});

describe('once another tab of the browser saves the records (letGo)', () => {
  it('nothing is written over them from this one, until it has read them again', async () => {
    const { at, written } = place(['saved', 'saved by the other tab']);
    const guarded = guardRecords(at);
    expect(await guarded.recordStorage.getItem(KEY)).toBe('saved');
    guarded.recordsRead(KEY);
    await guarded.recordStorage.setItem(KEY, 'one');
    guarded.letGo(KEY);
    await guarded.recordStorage.setItem(KEY, 'what this tab has in memory');
    await guarded.recordStorage.removeItem(KEY);
    expect(written).toEqual(['one']);

    expect(await guarded.recordStorage.getItem(KEY)).toBe('saved by the other tab');
    guarded.recordsRead(KEY);
    await guarded.recordStorage.setItem(KEY, 'two');
    expect(written).toEqual(['one', 'two']);
  });

  it('a save asked for before it, and not yet done, is not done', async () => {
    const { at, written } = place(['saved']);
    const guarded = guardRecords(at);
    expect(await guarded.recordStorage.getItem(KEY)).toBe('saved');
    guarded.recordsRead(KEY);
    const asked = guarded.recordStorage.setItem(KEY, 'asked before');
    guarded.letGo(KEY);
    await asked;
    expect(written).toEqual([]);
  });

  it('a save held in memory because it could not be written is let go of, and no longer said', async () => {
    let full = true;
    const written: string[] = [];
    const reads = ['saved', 'saved by the other tab'];
    const guarded = guardRecords({
      async read() {
        return reads.shift() ?? null;
      },
      async write(_key, value) {
        if (full) throw new Error('QuotaExceededError');
        written.push(value);
      },
      async remove() {},
    });
    const said: boolean[] = [];
    guarded.watchUnsaved((unsaved) => said.push(unsaved));
    expect(await guarded.recordStorage.getItem(KEY)).toBe('saved');
    guarded.recordsRead(KEY);
    await guarded.recordStorage.setItem(KEY, 'not written');
    expect(said).toEqual([true]);

    guarded.letGo(KEY);
    expect(said).toEqual([true, false]);
    // Read again, it is what the other tab saved, not what this one held.
    expect(await guarded.recordStorage.getItem(KEY)).toBe('saved by the other tab');
    full = false;
    guarded.recordsRead(KEY);
    await guarded.recordStorage.setItem(KEY, 'three');
    expect(written).toEqual(['three']);
  });
});

describe('a place that keeps older copies of the records', () => {
  /** A place that notes, in order, what it is asked to do. */
  function noting() {
    const asked: string[] = [];
    const at: RecordPlace = {
      async read() {
        asked.push('read');
        return 'saved';
      },
      async write(_key, value) {
        asked.push(`write ${value}`);
      },
      async remove() {
        asked.push('remove');
      },
      async forget(_key, how, id) {
        asked.push(`forget ${how}${id ? ` ${id}` : ''}`);
      },
      async opened() {
        asked.push('opened');
      },
    };
    return { at, asked };
  }

  it('is told once the store has read the records, after the read and before any save, and told of a drop with whose account it is', async () => {
    const { at, asked } = noting();
    const guarded = guardRecords(at);
    await guarded.recordStorage.getItem(KEY);
    guarded.recordsRead(KEY);
    guarded.forgetCopies(KEY, 'drop', 'acct_1');
    await guarded.recordStorage.setItem(KEY, 'without the account');
    expect(asked).toEqual(['read', 'opened', 'forget drop acct_1', 'write without the account']);
  });

  it('is told nothing before the store has read the records', async () => {
    const { at, asked } = noting();
    const guarded = guardRecords(at);
    guarded.forgetCopies(KEY, 'clear');
    await guarded.recordStorage.setItem(KEY, 'an empty phone');
    expect(asked).toEqual([]);
  });
});
