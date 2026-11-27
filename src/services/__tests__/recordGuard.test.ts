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
