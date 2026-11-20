import { useState } from 'react';

import type { EmployeePayroll } from '@app/domain/payroll';
import { isCurrentSpan, SPAN_NAME, spanLabel, type Span, type SpanKind } from '@app/domain/spans';
import { rulesFor } from '@app/domain/stateRules';
import { backFromLunchAt, FLAG_LABEL, flagHelp, MEAL_NOTE_LABEL, overtimeSummary, mealSummary } from '@app/domain/time';
import { payrollHoursFile, payrollReport } from '@app/services/reports';
import { fmtDate, fmtDayShort, fmtHrs, fmtTime, fmtWeekday, ymd } from '@app/util/format';

import { useCompany } from '../lib/company';
import { CSV_TYPE, saveFile, XLSX_TYPE } from '../lib/download';
import { messageOf } from '../lib/errors';
import { currentSpan, hoursFileData, payrollFor, payrollViews, reportRange, spanOptions, step } from '../lib/payroll';
import { parseDay } from '../lib/ranges';
import { go } from '../lib/router';
import { A, Button, count, Ledger, Notice, Seg } from '../ui/kit';
import { usePeople } from '../ui/people';
import { PageHead } from './Shell';
import { SettingsNotices } from './settingsNotices';

const LEAVE_LABEL = { holiday: 'Holiday', pto: 'PTO', sick: 'Sick' } as const;

/** The span the address names, or the one today falls in. */
function useSpan(view: string | null, at: string | null): { span: Span; views: SpanKind[] } {
  const ctx = useCompany();
  const views = payrollViews(ctx.shaped);
  const kind = (views.find((v) => v === view) ?? views[0]) as SpanKind;
  const moment = (at ? parseDay(at) : undefined) ?? ctx.now;
  const span = currentSpan(kind, moment, ctx.shaped);
  return { span, views };
}

export function SpanBar({ span, views, base, onMove }: { span: Span; views: SpanKind[]; base?: string; onMove?: (to: Span) => void }) {
  const ctx = useCompany();
  const latest = isCurrentSpan(span, ctx.now, spanOptions(ctx.shaped));
  const to = (s: Span) => (onMove ? onMove(s) : go(`${base}?view=${s.kind}&at=${ymd(s.start)}`, { replace: true }));
  return (
    <div className="span-bar">
      <Seg
        label="Show hours by"
        value={span.kind}
        onChange={(kind) => to(currentSpan(kind, Math.min(span.start + 86_400_000, ctx.now), ctx.shaped))}
        options={views.map((v) => ({ value: v, label: SPAN_NAME[v] }))}
      />
      <div className="span-step" role="group" aria-label="Move between spans">
        <Button kind="line" small onClick={() => to(step(span, -1, ctx.shaped))}>Earlier</Button>
        <span className="span-now">
          <span className="h3 num" aria-live="polite">{spanLabel(span)}</span>
          {!latest ? <Button kind="quiet" small className="btn-flush" onClick={() => to(currentSpan(span.kind, ctx.now, ctx.shaped))}>Back to now</Button> : null}
        </span>
        <Button kind="line" small disabled={latest} onClick={() => to(step(span, 1, ctx.shaped))}>Later</Button>
      </div>
    </div>
  );
}

const h = (n: number) => (n ? fmtHrs(n) : <span className="zero">0.00</span>);

export function PayrollPage({ view, at }: { view: string | null; at: string | null }) {
  const ctx = useCompany();
  const people = usePeople();
  const { span, views } = useSpan(view, at);
  const table = payrollFor(ctx.shaped, span, ctx.now);
  const rules = rulesFor(ctx.shaped.company.state);
  const [error, setError] = useState<string | null>(null);
  const shown = table.rows.filter((r) => r.total > 0 || r.daysWorked > 0 || r.needsFix > 0);
  const range = reportRange(span);
  const running = span.start <= ctx.now && ctx.now < span.end && shown.some((r) => r.days.some((d) => d.open));
  const nothing = table.totals.total === 0 && table.totals.needsFix === 0;

  const download = (make: () => { name: string; bytes: Uint8Array }, type: string) => {
    setError(null);
    try {
      const file = make();
      saveFile(file.name, file.bytes, type);
    } catch (e) {
      setError(`The file could not be made: ${messageOf(e)}`);
    }
  };

  return (
    <>
      <PageHead
        title="Time and payroll"
        lede={`Hours for each person, worked out as the app works them. ${overtimeSummary(rules)} Every figure is before taxes.`}
      />
      <SettingsNotices />
      <SpanBar span={span} views={views} base="/payroll" />
      {span.kind === 'period' && span.payDate ? (
        <p className="muted">
          Pay date {fmtWeekday(span.payDate)}, {fmtDayShort(span.payDate)}, {new Date(span.payDate).getFullYear()}.
          {span.movedBecause ? ` ${span.movedBecause}, so it moved.` : ''}
        </p>
      ) : null}
      {table.totals.needsFix ? (
        <Notice tone="warn" title={`${count(table.totals.needsFix, 'shift')} with no clock-out`}>
          A shift with no clock-out counts no hours until a supervisor sets its end in the app. The people with one are marked below.
        </Notice>
      ) : null}
      {table.totals.mealFlags ? (
        <Notice tone="warn" title={`${count(table.totals.mealFlags, 'lunch flag')} to review`}>
          {mealSummary(rules)} Flags are for review. Nothing is paid or docked automatically.
        </Notice>
      ) : null}
      {table.offRoster.length ? (
        <Notice tone="warn" title={`${count(table.offRoster.length, 'person', 'people')} off the app’s roster with hours in this ${SPAN_NAME[span.kind].toLowerCase()}`}>
          {table.offRoster.map((r) => `${people.name(r.employee.id)}, ${fmtHrs(r.total)} hours`).join('; ')}. Like the phones, the table and the files leave out someone taken off the roster. Pay these hours by hand, or put the person back on the roster on the <A href="/roster">Roster page</A> for this payroll.
        </Notice>
      ) : null}
      {table.heldBack.length ? (
        <Notice tone="warn" title={`${count(table.heldBack.length, 'person', 'people')} with hours and no employee record yet`}>
          {table.heldBack.map((r) => `${people.name(r.employee.id)}, ${fmtHrs(r.total)} hours`).join('; ')}. They are in this table and the workbook, but not in the hours file: a payroll system cannot match them without the payroll ID their employee record carries. Someone the sign-in roster names is on the <A href="/roster">Roster page</A>, under On the sign-in roster, not in the app: added to the app’s roster there, they keep these hours.
        </Notice>
      ) : null}
      <Ledger>
          <caption className="sr-only">Hours for {spanLabel(span)}</caption>
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="r">Days</th>
              <th scope="col" className="r">ST</th>
              <th scope="col" className="r">OT 1.5x</th>
              <th scope="col" className="r">DT 2x</th>
              <th scope="col" className="r">Holiday</th>
              <th scope="col" className="r">PTO</th>
              <th scope="col" className="r">Sick</th>
              <th scope="col" className="r">Total</th>
              <th scope="col" className="r">Meal flags</th>
              <th scope="col" className="r">To fix</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.employee.id} className={r.needsFix ? 'warn-row' : undefined}>
                <th scope="row">
                  <span className="nowrap"><A className="rowlink" href={`/payroll/${encodeURIComponent(r.employee.id)}?view=${span.kind}&at=${ymd(span.start)}`}>{people.name(r.employee.id)}</A></span>
                  {r.employee.title ? <span className="under">{r.employee.title}</span> : null}
                  {r.days.some((d) => d.open) ? <span className="under"><span className="tag tag-ok">On the clock</span></span> : null}
                  {people.placeholders.has(r.employee.id) ? <span className="under">No employee record yet: add them on the <A href="/roster">Roster page</A></span> : null}
                </th>
                <td className="r num">{r.daysWorked}</td>
                <td className="hrs">{h(r.reg)}</td>
                <td className="hrs">{h(r.ot)}</td>
                <td className="hrs">{h(r.dt)}</td>
                <td className="hrs">{h(r.holiday)}</td>
                <td className="hrs">{h(r.pto)}</td>
                <td className="hrs">{h(r.sick)}</td>
                <td className="hrs" style={{ fontWeight: 700 }}>{fmtHrs(r.total)}</td>
                <td className="r num">{r.mealFlags || <span className="zero">0</span>}</td>
                <td className="r num">{r.needsFix ? <span className="tag tag-warn">{r.needsFix}</span> : <span className="zero">0</span>}</td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={11} className="ledger-empty">
                  No hours in this {SPAN_NAME[span.kind].toLowerCase()}. Hours arrive here when the crew clocks in and out with the MineMuster app and their phones have signal.
                </td>
              </tr>
            ) : null}
          </tbody>
          {shown.length ? (
          <tfoot>
            <tr>
              <th scope="row">
                Total
                <span className="under">{count(shown.length, 'person', 'people')} with hours, of {table.rows.length} on the app’s roster</span>
              </th>
              <td className="r num">{table.totals.daysWorked}</td>
              <td className="hrs">{fmtHrs(table.totals.reg)}</td>
              <td className="hrs">{fmtHrs(table.totals.ot)}</td>
              <td className="hrs">{fmtHrs(table.totals.dt)}</td>
              <td className="hrs">{fmtHrs(table.totals.holiday)}</td>
              <td className="hrs">{fmtHrs(table.totals.pto)}</td>
              <td className="hrs">{fmtHrs(table.totals.sick)}</td>
              <td className="hrs">{fmtHrs(table.totals.total)}</td>
              <td className="r num">{table.totals.mealFlags}</td>
              <td className="r num">{table.totals.needsFix}</td>
            </tr>
          </tfoot>
          ) : null}
        </Ledger>
      {running ? <p className="small muted">The hours of anyone on the clock are counted up to now, and grow until they clock out.</p> : null}
      <section className="section no-print" aria-labelledby="pay-files">
        <h2 className="h2" id="pay-files">Files for payroll</h2>
        <p className="section-note">
          Made from these same figures, so they agree to the hundredth. Hours only: no hourly rate is ever on the server, in this page or in a file.
          {table.missingPayrollIds ? (
            <>
              {' '}{table.missingPayrollIds === 1 ? '1 person with hours has' : `${table.missingPayrollIds} people with hours have`} no payroll ID yet. <A href="/roster#payroll-ids">Set {table.missingPayrollIds === 1 ? 'it' : 'them'} on the Roster page</A> before importing the hours file.
            </>
          ) : null}
        </p>
        <div className="row">
          {/* Made at the same moment as the table above, so a shift still running counts the same in both. */}
          <Button kind="main" disabled={nothing} onClick={() => download(() => payrollReport(ctx.shaped.data, range, ctx.now), XLSX_TYPE)}>Download payroll for Excel</Button>
          <Button kind="line" disabled={nothing} onClick={() => download(() => payrollHoursFile(hoursFileData(ctx.shaped), range, 'period', ctx.now), CSV_TYPE)}>Download the hours file, totals</Button>
          <Button kind="line" disabled={nothing} onClick={() => download(() => payrollHoursFile(hoursFileData(ctx.shaped), range, 'day', ctx.now), CSV_TYPE)}>Download the hours file, one line a day</Button>
        </div>
        {nothing ? <p className="small muted">There are no hours in this {SPAN_NAME[span.kind].toLowerCase()}, so there is nothing to download yet.</p> : null}
        {error ? <Notice tone="bo" live>{error}</Notice> : null}
      </section>
    </>
  );
}

export function PayrollPersonPage({ id, view, at }: { id: string; view: string | null; at: string | null }) {
  const ctx = useCompany();
  const people = usePeople();
  const { span, views } = useSpan(view, at);
  const rules = rulesFor(ctx.shaped.company.state);
  const row: EmployeePayroll | undefined = payrollFor(ctx.shaped, span, ctx.now).rows.find((r) => r.employee.id === id);
  const back = <A href={`/payroll?view=${span.kind}&at=${ymd(span.start)}`}>Time and payroll</A>;
  if (!row) {
    return (
      <>
        <PageHead title="Not on the payroll" crumb={back} />
        <Notice tone="info">This person is not on the app’s roster, so they have no payroll here.</Notice>
      </>
    );
  }
  const days = row.days.filter((d) => d.shifts.length > 0);
  const notTheirs = people.doubts.filter((d) => d.kind === 'shift' && d.personId === id && d.at >= span.start && d.at < span.end);
  return (
    <>
      <PageHead title={people.name(id)} crumb={back} lede={`${row.employee.title ? `${row.employee.title}. ` : ''}Each day worked, the way the timesheet works it out.`} />
      <SpanBar span={span} views={views} base={`/payroll/${encodeURIComponent(id)}`} />
      {notTheirs.length ? (
        <Notice tone="warn" title={`${count(notTheirs.length, 'shift')} here sent from an account that is not theirs`}>
          {notTheirs.map((d) => `${fmtDate(d.at)}: ${d.why.replace(/^Sent/, 'sent')}`).join('; ')}. The server takes a crew member’s shift for anyone in the company. Check these hours with them before payroll.
        </Notice>
      ) : null}
      <Ledger>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">In</th>
              <th scope="col">Lunch taken</th>
              <th scope="col">Out</th>
              <th scope="col" className="r">On site</th>
              <th scope="col" className="r">Lunch hrs</th>
              <th scope="col" className="r">Worked</th>
              <th scope="col" className="r">ST</th>
              <th scope="col" className="r">OT</th>
              <th scope="col" className="r">DT</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              // Every lunch of the day, a second lunch on a long day included.
              const lunches = d.shifts.flatMap((s) => s.lunches);
              const missing = d.flags.includes('missing_out');
              const note = d.shifts.map((s) => (s.mealNote ? MEAL_NOTE_LABEL[s.mealNote] : '')).filter(Boolean).join('; ');
              return (
                <tr key={d.dayStart} className={missing ? 'warn-row' : undefined}>
                  <th scope="row" className="nowrap">{fmtDate(d.dayStart)}</th>
                  <td className="nowrap num">{d.firstIn ? fmtTime(d.firstIn) : ''}</td>
                  <td className="nowrap num">
                    {lunches.length ? (
                      lunches.map((lunch, i) => {
                        const back = backFromLunchAt(lunch, ctx.now);
                        return <span key={i} style={{ display: 'block' }}>{fmtTime(lunch.start.at)}{back ? ` to ${fmtTime(back)}` : ', at lunch now'}</span>;
                      })
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="nowrap num">{missing ? <span className="tag tag-warn">Missing</span> : d.open ? <span className="tag tag-ok">On the clock</span> : d.lastOut ? fmtTime(d.lastOut) : ''}</td>
                  <td className="hrs">{missing ? '' : fmtHrs(d.gross)}</td>
                  <td className="hrs">{missing ? '' : fmtHrs(d.lunch)}</td>
                  <td className="hrs" style={{ fontWeight: 700 }}>{missing ? '' : fmtHrs(d.paid)}</td>
                  <td className="hrs">{h(d.reg)}</td>
                  <td className="hrs">{h(d.ot)}</td>
                  <td className="hrs">{h(d.dt)}</td>
                  <td className="small">
                    {/* What each flag means is written out, not left in a tooltip a keyboard or a finger cannot reach. */}
                    {d.flags.map((f) => (
                      <span key={f} className="flag">
                        <span className="tag tag-warn">{FLAG_LABEL[f]}</span>
                        <span className="under">{flagHelp(f, rules)}</span>
                      </span>
                    ))}
                    {note ? <span className="under">{note}</span> : null}
                  </td>
                </tr>
              );
            })}
            {days.length === 0 ? <tr><td colSpan={11} className="ledger-empty">No shifts in this {SPAN_NAME[span.kind].toLowerCase()}.</td></tr> : null}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>Hours worked</th>
              <td className="hrs">{fmtHrs(row.gross)}</td>
              <td className="hrs">{fmtHrs(row.lunch)}</td>
              <td className="hrs">{fmtHrs(row.paid)}</td>
              <td className="hrs">{fmtHrs(row.reg)}</td>
              <td className="hrs">{fmtHrs(row.ot)}</td>
              <td className="hrs">{fmtHrs(row.dt)}</td>
              <td />
            </tr>
          </tfoot>
        </Ledger>
      {row.leave.length ? (
        <section className="section" aria-labelledby="leave-title">
          <h2 className="h2" id="leave-title">Paid leave</h2>
          <p className="section-note">Paid at straight time. It never counts toward overtime.</p>
          <Ledger>
              <thead><tr><th scope="col">Day</th><th scope="col">Type</th><th scope="col" className="r">Hours</th><th scope="col">Note</th><th scope="col">Entered by</th></tr></thead>
              <tbody>
                {row.leave.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">{fmtDate(l.day)}</th>
                    <td>{LEAVE_LABEL[l.type]}</td>
                    <td className="hrs">{fmtHrs(l.hours)}</td>
                    <td>{l.note ?? ''}</td>
                    <td>{people.name(l.enteredBy)}</td>
                  </tr>
                ))}
              </tbody>
            </Ledger>
        </section>
      ) : null}
      <dl className="facts" style={{ maxWidth: '28rem' }}>
        <div><dt>Hours worked</dt><dd>{fmtHrs(row.paid)}</dd></div>
        <div><dt>Paid leave</dt><dd>{fmtHrs(row.holiday + row.pto + row.sick)}</dd></div>
        <div><dt>Total on the check</dt><dd>{fmtHrs(row.total)}</dd></div>
      </dl>
      <p className="small muted">Hours before taxes. The pay stub is the official figure.</p>
    </>
  );
}
