import { useEffect, useRef, useState, type ReactNode } from 'react';

import { keepsTime, stateName } from '@app/domain/company';
import { fmtDateTime, fmtRelativeDay, fmtTime } from '@app/util/format';

import { signOut } from '../lib/api';
import { billingWords, gate, type Billing } from '../lib/billing';
import { useBilling } from '../lib/billingState';
import { useCompany } from '../lib/company';
import { match, onLink, useLocation } from '../lib/router';
import type { CompanyChoice } from '../lib/server';
import { browserZone, sameClock } from '../lib/timezone';
import { zoneLabel } from '../lib/zones';
import { CompanyLogoPlate, MineMusterLogo } from '../ui/brand';
import { Boundary } from '../ui/boundary';
import { Button, Loading, Notice } from '../ui/kit';
import { AccountPage } from './AccountPage';
import { BillingPage, StatusPanel } from './BillingPage';
import { CompanyPage } from './CompanyPage';
import { DefectsPage } from './DefectsPage';
import { ExamSheetPage, ExamSheetsPage } from './ExamSheetsPage';
import { ExportsPage } from './ExportsPage';
import { FleetPage } from './FleetPage';
import { OverviewPage } from './OverviewPage';
import { PayrollPage, PayrollPersonPage } from './PayrollPage';
import { ChecklistPage, ExamPage, RecordsPage } from './RecordsPage';
import { RequestPage, RequestsPage } from './RequestsPage';
import { RosterPage } from './RosterPage';

interface NavItem {
  href: string;
  label: string;
  count?: number;
  /** What the count is of, for a screen reader: "open", or "waiting" for the requests to join. */
  counted?: string;
  hot?: boolean;
  /** Paths under this one belong to it. */
  owns: (path: string) => boolean;
}

const NARROW = '(max-width: 56rem)';

/** Whether the window is narrow enough that the sidebar is a drawer behind the Menu button. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const on = () => setNarrow(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** The supervisor's dashboard: the sidebar, and the page the address names. */
export function Shell({ email, companies, onPick }: { email: string; companies: CompanyChoice[]; onPick: (id: string) => void }) {
  const ctx = useCompany();
  const billing = useBilling();
  const { path, query } = useLocation();
  const narrow = useNarrow();
  const [navOpen, setNavOpen] = useState(false);
  const drawer = narrow && navOpen;
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const firstPath = useRef(true);
  // Where the focus goes once the drawer is shut: the new page's heading, or back to the Menu button.
  const toHeading = useRef(false);
  const toMenu = useRef(false);
  const company = ctx.shaped.company;
  const timeKept = keepsTime(company);
  const pending = ctx.requests.filter((r) => r.status === 'pending').length;
  const { board } = ctx;

  const closeNav = () => {
    toMenu.current = true;
    setNavOpen(false);
  };

  // A new page: the drawer shuts, and the page's heading takes the focus, so a screen reader says where it is.
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    toHeading.current = true;
    setNavOpen(false);
  }, [path]);

  useEffect(() => {
    if (navOpen) return;
    if (toHeading.current) {
      toHeading.current = false;
      toMenu.current = false;
      // A link to a part of a page (`/roster#payroll-ids`) lands on that part when it can take the focus; else on the heading.
      const part = window.location.hash.length > 1 ? document.getElementById(window.location.hash.slice(1)) : null;
      if (part && part.getAttribute('tabindex') === '-1') part.focus();
      else mainRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    } else if (toMenu.current) {
      toMenu.current = false;
      menuRef.current?.focus();
    }
  });

  useEffect(() => {
    if (!navOpen) return;
    if (!narrow) {
      setNavOpen(false);
      return;
    }
    sideRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNav();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [navOpen, narrow]);

  const nav: NavItem[] = [
    { href: '/', label: 'Overview', owns: (p) => p === '/' },
    { href: '/roster', label: 'Roster', count: pending || undefined, counted: 'waiting', owns: (p) => p.startsWith('/roster') },
    { href: '/fleet', label: 'Fleet', owns: (p) => p.startsWith('/fleet') },
    { href: '/sheets', label: 'Exam sheets', owns: (p) => p.startsWith('/sheets') },
    { href: '/records', label: 'Checklists and exams', owns: (p) => p.startsWith('/records') || p.startsWith('/checklists') || p.startsWith('/exams') },
    {
      href: '/defects',
      label: 'Defects and conditions',
      count: board.badOrders.length + board.conditions.length || undefined,
      hot: board.dangers.length > 0 || board.redTagged.length > 0,
      owns: (p) => p.startsWith('/defects'),
    },
    { href: '/requests', label: 'Maintenance requests', count: board.requests.length || undefined, owns: (p) => p.startsWith('/requests') },
    ...(timeKept ? [{ href: '/payroll', label: 'Time and payroll', owns: (p: string) => p.startsWith('/payroll') }] : []),
    { href: '/exports', label: 'Exports', owns: (p) => p.startsWith('/exports') },
    { href: '/company', label: 'Company', owns: (p) => p.startsWith('/company') },
    { href: '/billing', label: 'Billing', owns: (p) => p.startsWith('/billing') },
  ];

  let page: ReactNode;
  let params: Record<string, string> | null;
  if (path === '/') page = <OverviewPage />;
  else if (path === '/roster') page = <RosterPage />;
  else if (path === '/fleet') page = <FleetPage />;
  else if (path === '/sheets') page = <ExamSheetsPage />;
  else if (path === '/sheets/add') page = <ExamSheetPage />;
  else if ((params = match('/sheets/sheet/:id', path))) page = <ExamSheetPage id={params.id} />;
  else if (path === '/company') page = <CompanyPage />;
  else if (path === '/records') page = <RecordsPage day={query.get('day')} />;
  else if ((params = match('/checklists/:id', path))) page = <ChecklistPage id={params.id} />;
  else if ((params = match('/exams/:id', path))) page = <ExamPage id={params.id} />;
  else if (path === '/defects') page = <DefectsPage />;
  else if (path === '/requests') page = <RequestsPage show={query.get('show')} />;
  else if ((params = match('/requests/:id', path))) page = <RequestPage id={params.id} />;
  else if (path === '/payroll' && timeKept) page = <PayrollPage view={query.get('view')} at={query.get('at')} />;
  else if ((params = match('/payroll/:id', path)) && timeKept) page = <PayrollPersonPage id={params.id} view={query.get('view')} at={query.get('at')} />;
  else if (path === '/exports') page = <ExportsPage />;
  else if (path === '/billing') page = <BillingPage email={email} started={query.get('started')} />;
  else if (path === '/account') page = <AccountPage email={email} openCompany={ctx.choice.id} onPick={onPick} />;
  else page = <NotFound timeKept={timeKept} path={path} />;
  // Without the records, an empty list would look like nothing is open. Say so instead.
  if (ctx.recordsError && path !== '/' && path !== '/roster' && path !== '/billing' && path !== '/account') page = <PageHead title="The records are not loaded" />;
  // With no trial or subscription, every page but Billing is the panel to start one (billing.ts decides).
  const shut = gate(billing.view, path);
  if (shut === 'wait') page = <Loading>Checking billing</Loading>;
  else if (shut === 'unknown' && billing.view.kind === 'failed') page = <BillingUnknown message={billing.view.message} />;
  else if ((shut === 'start' || shut === 'restart') && billing.view.kind === 'known') page = <BillingGate email={email} billing={billing.view.billing} />;
  // Just let in (back from checkout, say): the records are on their way, so no page says there are none.
  else if (shut === 'in' && ctx.recordsHeld && path !== '/billing' && path !== '/roster' && path !== '/account') page = <Loading>Loading the records</Loading>;

  const zone = ctx.company?.timezone;
  const here = browserZone();
  const zoneDiffers = !!zone && !sameClock(zone, here, new Date(ctx.now).getFullYear());
  // Where days and pay periods decide the figures, the whole reason; elsewhere one line, with the reason a click away.
  const zoneMatters = path.startsWith('/payroll') || path.startsWith('/exports');

  return (
    <div className={navOpen ? 'shell nav-open' : 'shell'}>
      <a className="skip" href="#main" inert={drawer} onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to the page</a>
      <header className="topbar dark" inert={drawer}>
        <Button kind="ondark" aria-expanded={navOpen} aria-controls="side" ref={menuRef} onClick={() => setNavOpen(true)}>Menu</Button>
        <span className="topbar-company">{company.name || ctx.choice.name}</span>
        <MineMusterLogo width="6.5rem" />
      </header>
      {/* On a narrow screen the sidebar is a drawer: out of reach while shut, and the only thing in reach while open. */}
      <aside className="side dark" id="side" aria-label="MineMuster" ref={sideRef} inert={narrow && !navOpen}>
        {drawer ? <Button kind="ondark" small className="side-close" onClick={closeNav}>Close the menu</Button> : null}
        <a href="/" onClick={onLink} aria-label="MineMuster, overview">
          <MineMusterLogo className="side-logo" />
        </a>
        <div className="side-company">
          <CompanyLogoPlate logo={company.logo} name={company.name} />
          <p className="side-company-name">{company.name || ctx.choice.name}</p>
          <p className="side-company-meta">
            {stateName(company.state) || (ctx.shaped.settingsFrom === 'phones' ? 'No state set on the phones' : company.state)}
            {timeKept ? '' : '. Safety forms only, no time clock'}
          </p>
          {companies.length > 1 ? (
            <label className="field">
              <span className="sr-only">Company</span>
              <select className="select" value={ctx.choice.id} onChange={(e) => onPick(e.target.value)}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.role === 'supervisor' ? '' : ' (crew)'}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <nav aria-label="Pages">
          <ul className="nav">
            {nav.map((item) => (
              <li key={item.href}>
                <a href={item.href} onClick={onLink} aria-current={item.owns(path) ? 'page' : undefined}>
                  <span>{item.label}</span>
                  {item.count ? (
                    <span className={item.hot ? 'nav-count nav-count-bo' : 'nav-count'}>
                      {item.count}
                      <span className="sr-only"> {item.counted ?? 'open'}</span>
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="side-foot">
          <span>Signed in as {email}</span>
          <a className="btn btn-quiet" href="/account" onClick={onLink} aria-current={path === '/account' ? 'page' : undefined}>Your account</a>
          <Button kind="quiet" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </aside>
      <main className="main" id="main" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }} inert={drawer}>
        <div className="page">
          {ctx.recordsError ? (
            <Notice tone="warn" title="The records could not be loaded">
              {ctx.recordsError} The roster still works. Checklists, exams, requests and hours show once the records load.
            </Notice>
          ) : null}
          {zoneDiffers && zone ? <ZoneNotice zone={zone} here={here} full={zoneMatters} /> : null}
          <Boundary key={path} fallback={() => <PageFailed />}>{page}</Boundary>
        </div>
      </main>
      {navOpen ? <div aria-hidden="true" onClick={closeNav} style={{ position: 'fixed', inset: 0, zIndex: 35 }} /> : null}
    </div>
  );
}

/** This computer keeps another clock than the company: days, workweeks and pay periods here are counted in this one. */
function ZoneNotice({ zone, here, full }: { zone: string; here: string; full: boolean }) {
  const title = `Times are shown in this computer’s time zone, ${zoneLabel(here)}. The company keeps ${zoneLabel(zone)}.`;
  const why = 'Days, workweeks and pay periods here are counted in this computer’s time, as the app counts them in a phone’s. Open the dashboard on a computer set to the company’s time zone before running payroll.';
  if (full) return <Notice tone="info" title={title}>{why}</Notice>;
  return (
    <div className="notice notice-info notice-line">
      <p className="notice-title">{title}</p>
      <details className="disclosure">
        <summary>Why this matters</summary>
        <p>{why}</p>
      </details>
    </div>
  );
}

/**
 * Where billing stands could not be checked: the page does not open on a
 * guess. It says why, and checks again. Billing and signing out still work.
 */
function BillingUnknown({ message }: { message: string }) {
  const { check } = useBilling();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHead title="Where billing stands could not be checked" actions={false} />
      <Notice tone="warn">
        <p>
          {message} This page opens once the server says the company has MineMuster. <a href="/billing" onClick={onLink}>Go to Billing</a>.
        </p>
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <Button
            kind="ink"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await check();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Checking' : 'Check again'}
          </Button>
        </div>
      </Notice>
    </>
  );
}

/** A page the company has not got: the Billing page's own panel, to start the trial or the subscription again. */
function BillingGate({ email, billing }: { email: string; billing: Billing }) {
  return (
    <>
      <PageHead title={billingWords(billing).title} actions={false} />
      <StatusPanel billing={billing} email={email} gated />
    </>
  );
}

function PageFailed() {
  return (
    <>
      <PageHead title="This page could not be shown" />
      <Notice tone="bo">
        Something in the records on this page is not the shape the app writes, so the page stopped. The other pages still work. <a href="/" onClick={onLink}>Go to the overview</a>, or reload the page to try it again.
      </Notice>
      <div className="row">
        <Button kind="line" onClick={() => window.location.reload()}>Reload the page</Button>
      </div>
    </>
  );
}

function NotFound({ timeKept, path }: { timeKept: boolean; path: string }) {
  const payroll = path.startsWith('/payroll') && !timeKept;
  return (
    <>
      <PageHead title={payroll ? 'The company does not keep time' : 'There is no page here'} />
      <Notice tone="info">
        {payroll
          ? <>This company uses MineMuster for the safety forms only, so there are no hours or payroll. A supervisor can turn the time clock on, on the <a href="/company" onClick={onLink}>Company page</a>.</>
          : 'The address may be old, or the record may have been taken off a phone.'}{' '}
        <a href="/" onClick={onLink}>Go to the overview</a>.
      </Notice>
    </>
  );
}

/** The top of every page: what it is, and when the records last changed, from a phone or from here. */
export function PageHead({ title, lede, crumb, actions }: { title: string; lede?: ReactNode; crumb?: ReactNode; actions?: ReactNode | false }) {
  const ctx = useCompany();
  const companyName = ctx.shaped.company.name || ctx.choice.name;
  // Each page names itself in the browser's tab, its history and its bookmarks.
  useEffect(() => {
    document.title = [title, companyName, 'MineMuster'].filter(Boolean).join(' – ');
  }, [title, companyName]);
  return (
    <header className="page-head">
      <div className="page-head-text">
        {crumb ? <p className="crumb">{crumb}</p> : null}
        <h1 className="h1" tabIndex={-1}>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions === false ? null : actions ?? <Arrived />}
    </header>
  );
}

export function Arrived() {
  const ctx = useCompany();
  const [busy, setBusy] = useState(false);
  const last = ctx.shaped.lastArrived;
  return (
    <div className="arrived no-print">
      <span>
        {ctx.recordsError
          ? 'Records not loaded.'
          : last
            ? <>Records last changed {fmtRelativeDay(last.at, ctx.now).toLowerCase() === 'today' ? `today at ${fmtTime(last.at)}` : fmtDateTime(last.at)}.</>
            : 'No records have arrived from the phones yet.'}
        <br />
        <span className="small">Loaded at {fmtTime(ctx.loadedAt)}.</span>
      </span>
      <Button
        kind="line"
        small
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await ctx.reload();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Loading' : 'Load new records'}
      </Button>
    </div>
  );
}
