import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { companyBilling } from './api';
import { nextView, type BillingView } from './billing';
import { mayHaveLostRole } from './errors';

/**
 * Where the open company's billing stands, for its supervisors. Asked when the
 * company opens, before its records (which load only once it says the company
 * is in), and again when the person comes back to this tab (from Stripe's
 * billing portal in another, say), at most once a half minute. A check that is
 * under way keeps the last answer on the page, and so does one that fails once
 * an answer is known (`nextView`), so a page never flickers shut, or open,
 * because one request did not get through.
 */

interface BillingState {
  view: BillingView;
  /** Ask the server again; resolves to its answer. */
  check: () => Promise<BillingView>;
}

const Ctx = createContext<BillingState | null>(null);

export function useBilling(): BillingState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useBilling is used outside a company.');
  return value;
}

const AGAIN_AFTER_MS = 30_000;

export function BillingProvider({ companyId, recheckRole, children }: { companyId: string; recheckRole: () => Promise<void>; children: ReactNode }) {
  const [view, setView] = useState<BillingView>({ kind: 'checking' });
  const last = useRef(0);
  const turn = useRef(0);

  const check = useCallback(async () => {
    const mine = ++turn.current;
    last.current = Date.now();
    const answer = await companyBilling(companyId);
    if (mine === turn.current) setView((had) => nextView(had, answer));
    // Turned down for want of the role: the account may no longer be a supervisor here.
    if (answer.kind === 'failed' && mayHaveLostRole(answer.code)) void recheckRole();
    return answer;
  }, [companyId, recheckRole]);

  useEffect(() => {
    void check();
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - last.current > AGAIN_AFTER_MS) void check();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [check]);

  return <Ctx.Provider value={{ view, check }}>{children}</Ctx.Provider>;
}
