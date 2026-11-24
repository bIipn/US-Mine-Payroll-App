import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordRow } from '../src/lib/server';

/**
 * loadRecords against a stand-in for PostgREST: rows in the order the query
 * asks for, cut by .range(from, to), and never more than `maxRows` a request
 * (PostgREST's max-rows; Supabase's default is 1000).
 */
const db = vi.hoisted(() => ({
  rows: [] as RecordRow[],
  maxRows: 1000,
  calls: [] as { order: string[]; from: number; to: number }[],
  /** Runs after each page is served, to change the table between two reads. */
  between: null as null | ((page: number) => void),
}));

vi.mock('../src/lib/supabase', () => {
  const query = () => {
    const order: string[] = [];
    const q = {
      select: () => q,
      eq: () => q,
      order: (column: string) => {
        order.push(column);
        return q;
      },
      range: (from: number, to: number) => {
        db.calls.push({ order: [...order], from, to });
        const sorted = [...db.rows].sort((a, b) => {
          for (const column of order) {
            const x = String(a[column as keyof RecordRow]);
            const y = String(b[column as keyof RecordRow]);
            if (x !== y) return x < y ? -1 : 1;
          }
          return 0;
        });
        const page = sorted.slice(from, Math.min(to + 1, from + db.maxRows));
        db.between?.(db.calls.length);
        return Promise.resolve({ data: page, error: null });
      },
    };
    return q;
  };
  return { supabase: { from: () => query() } };
});

const { loadRecords } = await import('../src/lib/api');
const { shapeRecords } = await import('../src/lib/records');

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const idOf = (n: number) => `s${String(n).padStart(5, '0')}`;
const shiftRow = (n: number, at = T0 + n * 1000): RecordRow => ({
  kind: 'shift',
  id: idOf(n),
  rev: `r${n}`,
  data: { id: idOf(n), employeeId: 'e1', clockIn: { at: T0 + n * 60_000 }, clockOut: { at: T0 + n * 60_000 + 3_600_000 }, lunches: [], breaks: [] },
  deleted: false,
  created_by: 'user-e1',
  updated_by: 'user-e1',
  created_at: new Date(at).toISOString(),
  updated_at: new Date(at).toISOString(),
});

beforeEach(() => {
  db.rows = [];
  db.maxRows = 1000;
  db.calls = [];
  db.between = null;
});

describe('loadRecords', () => {
  it('reads more than 1000 records a page at a time, on the primary key, until a page comes back empty', async () => {
    db.rows = Array.from({ length: 2500 }, (_, n) => shiftRow(n));
    const seen: number[] = [];
    const rows = await loadRecords('company-a', (n) => seen.push(n));
    expect(rows.length).toBe(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(seen).toEqual([1000, 2000, 2500]);
    expect(db.calls.map((c) => [c.from, c.to])).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2500, 3499]]);
    // Cut on kind and id, which never change, not on when a row changed.
    expect(db.calls.every((c) => c.order.join() === 'kind,id')).toBe(true);
    // Handed on oldest change first, as before.
    expect(rows.map((r) => r.id)).toEqual(db.rows.map((r) => r.id));
  });

  it('misses no record when a phone sends one again between two pages, and keeps its newer version', async () => {
    db.rows = Array.from({ length: 1500 }, (_, n) => shiftRow(n));
    db.between = (page) => {
      if (page !== 1) return;
      // A phone resends s00010 (a correction) after the first page was read.
      db.rows[10] = { ...db.rows[10], rev: 'r10b', updated_at: new Date(T0 + 10_000_000).toISOString() };
    };
    const rows = await loadRecords('company-a');
    expect(new Set(rows.map((r) => r.id)).size).toBe(1500);
    expect(rows.length).toBe(1500);
    const shaped = shapeRecords(rows);
    expect(shaped.data.shifts.length).toBe(1500);
  });

  it('keeps every record there was, once each, when a new one lands ahead of the page being read', async () => {
    const before = Array.from({ length: 1500 }, (_, n) => shiftRow(n + 10));
    db.rows = [...before];
    db.between = (page) => {
      if (page !== 1) return;
      // A new record sorts before everything read so far, so every row after it moves one place on,
      // and the first row of the next page is read again.
      db.rows.push({ ...shiftRow(1), updated_at: new Date(T0 + 20_000_000).toISOString() });
      db.rows[1200] = { ...db.rows[1200], rev: 'changed', updated_at: new Date(T0 + 30_000_000).toISOString() };
    };
    const rows = await loadRecords('company-a');
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(before.every((r) => ids.includes(r.id))).toBe(true);
    expect(rows.find((r) => r.id === db.rows[1200].id)?.rev).toBe('changed');
  });

  it('reads every record when the server hands back fewer rows a request than asked for', async () => {
    db.maxRows = 500;
    db.rows = Array.from({ length: 1200 }, (_, n) => shiftRow(n));
    const rows = await loadRecords('company-a');
    expect(rows.length).toBe(1200);
    expect(db.calls.map((c) => c.from)).toEqual([0, 500, 1000, 1200]);
  });

  it('says what went wrong when a page cannot be read', async () => {
    const { supabase } = await import('../src/lib/supabase');
    const from = supabase.from;
    (supabase as { from: unknown }).from = () => ({
      select() { return this; }, eq() { return this; }, order() { return this; },
      range: () => Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records'" } }),
    });
    await expect(loadRecords('company-a')).rejects.toThrow(/not set up for this yet/);
    (supabase as { from: unknown }).from = from;
  });
});
