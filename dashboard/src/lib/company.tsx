import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { loadCompany, loadJoinRequests, loadNotifications, loadRecords, loadRoster } from './api';
import { messageOf, notAllowed } from './errors';
import { board, type Board } from './overview';
import { shapeRecords, type Shaped } from './records';
import type { CompanyChoice, CompanyRow, JoinRequestRow, NotificationRow, RecordRow, RosterRow } from './server';

/**
 * Everything the dashboard shows for one company, loaded once and reloaded on
 * request: the company, its sign-in roster and join requests, and every record
 * its phones have sent, shaped for the app's own code.
 */

export interface CompanyState {
  choice: CompanyChoice;
  /** The signed-in account. */
  me: string;
  company: CompanyRow | null;
  roster: RosterRow[];
  requests: JoinRequestRow[];
  notifications: NotificationRow[];
  records: RecordRow[];
  shaped: Shaped;
  board: Board;
  /** When the records were last loaded from the server. */
  loadedAt: number;
  /** The records could not be loaded; the roster still can. */
  recordsError: string | null;
  now: number;
  reload: () => Promise<void>;
  reloadRoster: () => Promise<void>;
  /** Put a new join code on the company as soon as it is made. */
  setJoinCode: (code: string) => void;
  /**
   * Ask the server again which companies this account is a supervisor of. A
   * supervisor can be made crew, or taken off, while the page is open; then the
   * records come off the page and it shows what the crew sees.
   */
  recheckRole: () => Promise<void>;
}

const Ctx = createContext<CompanyState | null>(null);

export function useCompany(): CompanyState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useCompany is used outside a company.');
  return value;
}

export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

type Loaded = Omit<CompanyState, 'reload' | 'reloadRoster' | 'setJoinCode' | 'recheckRole' | 'now' | 'board' | 'shaped' | 'choice' | 'me'>;

export function CompanyProvider({ choice, me, recheckRole, children, loading, failed }: {
  choice: CompanyChoice;
  me: string;
  recheckRole: () => Promise<void>;
  children: ReactNode;
  loading: (progress: string) => ReactNode;
  failed: (message: string, retry: () => void) => ReactNode;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState('Loading the company');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(choice.join_code ?? null);
  const now = useNow();
  const turn = useRef(0);

  const loadPeople = useCallback(async () => {
    const [company, roster, requests, notifications] = await Promise.all([
      loadCompany(choice.id),
      loadRoster(choice.id),
      loadJoinRequests(choice.id),
      loadNotifications(choice.id).catch(() => [] as NotificationRow[]),
    ]);
    return { company, roster, requests, notifications };
  }, [choice.id]);

  const reload = useCallback(async () => {
    const mine = ++turn.current;
    setError(null);
    try {
      const people = await loadPeople();
      let records: RecordRow[] = [];
      let recordsError: string | null = null;
      try {
        records = await loadRecords(choice.id, (n) => mine === turn.current && setProgress(`Loading records: ${n.toLocaleString('en-US')} so far`));
      } catch (e) {
        recordsError = messageOf(e);
        if (notAllowed(e)) void recheckRole();
      }
      if (mine !== turn.current) return;
      setLoaded({ ...people, records, recordsError, loadedAt: Date.now() });
    } catch (e) {
      if (mine === turn.current) setError(messageOf(e));
      if (notAllowed(e)) void recheckRole();
    }
  }, [choice.id, loadPeople, recheckRole]);

  const reloadRoster = useCallback(async () => {
    const people = await loadPeople();
    setLoaded((had) => (had ? { ...had, ...people } : had));
  }, [loadPeople]);

  useEffect(() => {
    setLoaded(null);
    setProgress('Loading the company');
    void reload();
  }, [choice.id, reload]);

  // A new code from the server, after a role check, without loading everything again.
  useEffect(() => setCode(choice.join_code ?? null), [choice.join_code]);

  const shaped = useMemo(() => (loaded ? shapeRecords(loaded.records, { company: loaded.company ?? undefined, roster: loaded.roster }) : null), [loaded]);
  // Today moves on with the clock; the rest only when the records do.
  const today = new Date(now).toDateString();
  const theBoard = useMemo(() => (shaped ? board(shaped, Date.now()) : null), [shaped, today]);

  if (error && !loaded) return <>{failed(error, () => void reload())}</>;
  if (!loaded || !shaped || !theBoard) return <>{loading(progress)}</>;

  const value: CompanyState = {
    ...loaded,
    choice: { ...choice, join_code: code },
    me,
    recheckRole,
    shaped,
    board: theBoard,
    now,
    reload,
    reloadRoster,
    setJoinCode: setCode,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
