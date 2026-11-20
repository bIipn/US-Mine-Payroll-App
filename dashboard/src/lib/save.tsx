import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { stableJson } from '@app/domain/sync';

import { pushRecords, readRecord } from './api';
import { nextView } from './billing';
import { useBilling } from './billingState';
import { billingRefusal, CONFLICT_WORDS, followNewer, loadedRow, saveRecord, type Saved, type Want, type WrittenKind } from './changes';
import { useCompany } from './company';
import { mayHaveLostRole, messageOf, Problem } from './errors';
import type { RecordRow } from './server';
import { Notice } from '../ui/kit';

/**
 * Saving a record from a page: billing is asked first, the record is read
 * again and the save stops if a phone has sent a newer version, and what the
 * server took is put on the page without loading everything again
 * (`saveRecord` in changes.ts has the steps).
 */

export type SaveResult =
  | { ok: true; /** Said beside "saved" when there is something to add. */ note?: string; /** The record as the server now has it. */ row: RecordRow }
  | { ok: false; /** A newer version stopped the save, and the page now shows it. */ changed: boolean; words: string; /** That newer version, when the server showed one. */ row?: RecordRow };

export interface SaveWant extends Omit<Want, 'loaded'> {
  /**
   * The version a form was opened on, for a form that changes a record already
   * there: a version the page loaded since, by itself or because a phone sent
   * one, stops the save like one the server has. Left out, the save goes from
   * the version the page holds now, which is right for a new record and for a
   * button on a row the page has just drawn. Null is a form that opened when
   * there was no such record.
   */
  from?: RecordRow | null;
}

export function useSaver() {
  const ctx = useCompany();
  const billing = useBilling();
  // The latest of each, for a save that outlives the render it started in.
  const live = useRef({ ctx, billing });
  live.current = { ctx, billing };

  return useCallback(async ({ from, ...want }: SaveWant): Promise<SaveResult> => {
    const { ctx, billing } = live.current;
    try {
      // The server takes a record whatever billing says; these pages are for a company that has MineMuster.
      const shut = billingRefusal(nextView(billing.view, await billing.check()));
      if (shut) return { ok: false, changed: false, words: shut };

      const loaded = from === undefined ? loadedRow(ctx.records, want.kind, want.id) : from ?? undefined;
      const saved: Saved = await saveRecord(
        {
          read: (kind, id) => readRecord(ctx.choice.id, kind, id),
          push: (changes) => pushRecords(ctx.choice.id, changes),
          me: ctx.me,
          now: Date.now,
        },
        { ...want, loaded },
      );
      if (saved.ok) {
        // On the page goes whatever the server holds that the page does not: what was just written, or a record it already had.
        if (!saved.same || (!loaded && !saved.row.deleted)) ctx.applyRecords([saved.row]);
        return { ok: true, row: saved.row, ...(saved.conflict ? { note: CONFLICT_WORDS } : null) };
      }
      if (saved.why === 'changed') {
        if (saved.fresh) ctx.applyRecords([saved.fresh]);
        // The server shows this account nothing where it showed a record: billing or the role has changed.
        else if (saved.how === 'hidden') void ctx.recheckRole();
        return { ok: false, changed: true, words: saved.words, ...(saved.fresh ? { row: saved.fresh } : null) };
      }
      if (saved.why === 'not_kept') {
        // The server said it took the change and holds another version: the page shows the server's.
        ctx.applyRecords([saved.fresh]);
        return { ok: false, changed: true, words: saved.words, row: saved.fresh };
      }
      // Taken for this account's own earlier change: the server holds the version the page does, and its words say why.
      if (saved.why === 'repeat') return { ok: false, changed: false, words: saved.words };
      if (saved.reason === 'supervisor_only') void ctx.recheckRole();
      return { ok: false, changed: false, words: saved.words };
    } catch (e) {
      if (e instanceof Problem && mayHaveLostRole(e.code)) void ctx.recheckRole();
      return { ok: false, changed: false, words: messageOf(e) };
    }
  }, []);
}

/** What a page says about its last save. */
export interface Said {
  tone: 'ok' | 'warn' | 'bo';
  text: string;
}

/** The heading over what is said: none for a save that went through. */
export const SAID_TITLE: Record<Said['tone'], string | undefined> = { ok: undefined, warn: 'Look again', bo: 'Not saved' };

/** How a save went, in words. `done` is what to say when it went through. */
export function saidOf(result: SaveResult, done: string): Said {
  if (result.ok) return result.note ? { tone: 'warn', text: `${done} ${result.note}` } : { tone: 'ok', text: done };
  return { tone: result.changed ? 'warn' : 'bo', text: result.words };
}

/** What a page says about its last save: one thing at a time, the newest. */
export function useSaid(first: Said | null = null) {
  const [said, setSaid] = useState<Said | null>(first);
  // Loading the records again may show otherwise: what was said about the page before it goes.
  const { loadedAt } = useCompany();
  const loaded = useRef(loadedAt);
  useEffect(() => {
    if (loaded.current === loadedAt) return;
    loaded.current = loadedAt;
    setSaid(null);
  }, [loadedAt]);
  return {
    said,
    clear: () => setSaid(null),
    say: setSaid,
    /** Say how a save went, and whether it went through. */
    tell: (result: SaveResult, done: string) => {
      setSaid(saidOf(result, done));
      return result.ok;
    },
  };
}

/**
 * What was said about a save, where the person can see it. It is brought into
 * view when it appears or changes, for a result is no use above or below the
 * window. With `take` it takes the keyboard focus too, for when the control
 * that was pressed is gone from the page (a panel that shut, a unit taken
 * out). Anything that was not saved is announced at once (an alert); a save
 * that went through waits its turn (a status).
 */
export function SaidNotice({ said, take }: { said: Said | null; take?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!said || !el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (take) el.focus({ preventScroll: true });
    // Each thing said is a new object, so the same words said twice come into view twice.
  }, [said, take]);
  if (!said) return null;
  return (
    <div ref={ref} tabIndex={-1} className="said">
      <Notice tone={said.tone} title={SAID_TITLE[said.tone]} live alert={said.tone !== 'ok'}>{said.text}</Notice>
    </div>
  );
}

// ---- A word carried to the next page ---------------------------------------------------------------

let carried: Said | null = null;

/** Leave something to be said on the page the dashboard moves to next, such as that a new sheet was added. */
export function carryWord(said: Said): void {
  carried = said;
}

/** What the last page left to be said, once: read as this page opens, and gone for the next. */
export function useCarriedWord(): Said | null {
  const [said] = useState(() => carried);
  useEffect(() => {
    carried = null;
  }, []);
  return said;
}

export interface FormSaveHow {
  /** The record's name is a plural, as "the company settings" is. */
  plural?: boolean;
  /**
   * The change is to the record as the page draws it now, made with a button
   * beside it (stop using a sheet), not to what was typed into the form. It
   * goes from the version the page holds, which the person is looking at.
   */
  drawn?: boolean;
}

export interface FormSaver {
  save: (record: object | null, what: string, how?: FormSaveHow) => Promise<SaveResult>;
  /**
   * Told, each time the form is drawn, whether it holds nothing that is not
   * saved. A form with nothing typed in it shows the version the page holds,
   * so what is typed next is typed over that one, and the form works from it.
   */
  shows: (nothingTyped: boolean) => void;
}

/**
 * The version of a record a form is working from: the one the page held when
 * the form opened, then whatever the server answered with last. A form that
 * changes a record saves through this, so that what was typed over an older
 * version never goes over a newer one unseen: the first save after the record
 * changed is stopped and says what changed; the next goes from the newer one.
 * A form with nothing typed in it moves on to the version the page holds
 * (`shows`): loading the records again does not stop the next save for a
 * change the person has in front of them.
 */
export function useFormSaver(kind: WrittenKind, id: string): FormSaver {
  const ctx = useCompany();
  const save = useSaver();
  // Undefined until the first render has looked; null when the page held no such record then.
  const from = useRef<RecordRow | null | undefined>(undefined);
  const held = loadedRow(ctx.records, kind, id) ?? null;
  if (from.current === undefined) from.current = held;
  const page = useRef(held);
  page.current = held;
  return useMemo(
    () => ({
      save: async (record: object | null, what: string, how: FormSaveHow = {}): Promise<SaveResult> => {
        const result = await save({ kind, id, record, what, plural: how.plural, ...(how.drawn ? null : { from: from.current }) });
        if (result.row) from.current = result.row;
        return result;
      },
      shows: (nothingTyped: boolean) => {
        if (nothingTyped) from.current = page.current;
      },
    }),
    [save, kind, id],
  );
}

/**
 * The fields of a form over a record that may change under it. The form starts
 * from `saved`, the record's fields as the page holds them. When the page comes
 * to hold a newer version (a phone sent one, or the records were loaded again),
 * a field nobody touched takes the newer value and a field that was typed in
 * stays as typed (`followNewer`). `dirty` is whether anything differs from what
 * is saved now; `restart` puts the form back on given values, such as the
 * record as it was just saved.
 */
export function useFormFields<T extends object>(saved: T) {
  const [fields, setFields] = useState(saved);
  const opened = useRef(saved);
  const now = stableJson(saved);
  useEffect(() => {
    const was = opened.current;
    if (stableJson(was) === now) return;
    opened.current = saved;
    setFields((typed) => followNewer(was, typed, saved));
    // `now` is `saved` by value: the effect runs when the record's fields change, not on every render.
  }, [now]);
  return {
    fields,
    set: (part: Partial<T>) => setFields((had) => ({ ...had, ...part })),
    dirty: stableJson(fields) !== now,
    restart: (to: T) => {
      opened.current = to;
      setFields(to);
    },
  };
}
