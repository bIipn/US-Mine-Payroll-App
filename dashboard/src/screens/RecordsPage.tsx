import { useEffect, useState } from 'react';

import { examCounts, examFindings, examResult, shiftLabel } from '@app/domain/areaExam';
import { cardsBetween, dailyCards, dayClock } from '@app/domain/checklistCard';
import { keepsTime } from '@app/domain/company';
import { standard } from '@app/domain/standards';
import { CATEGORY_LABEL, checklistFor, findItem, isHazard, onTheCard } from '@app/domain/templates';
import { addDays, fmtDate, fmtDateLong, fmtDateTime, fmtMeter, fmtTime, startOfDay, ymd } from '@app/util/format';

import { useCompany } from '../lib/company';
import { recordDays } from '../lib/overview';
import { parseDay } from '../lib/ranges';
import { go } from '../lib/router';
import { A, Button, Cites, count, Ledger, Notice, TextField } from '../ui/kit';
import { ChecklistCardSheet, ExamPaper } from '../ui/paper';
import { DangerBand } from '../ui/danger';
import { usePeople } from '../ui/people';
import { PageHead } from './Shell';

/** The company's equipment checklists and pre shift exams, a day at a time, each opening as the paper it replaces. */
export function RecordsPage({ day: asked }: { day: string | null }) {
  const ctx = useCompany();
  const people = usePeople();
  const { data } = ctx.shaped;
  const days = recordDays(data);
  const day = (asked ? parseDay(asked) : undefined) ?? days[0]?.day ?? startOfDay(ctx.now);
  const end = addDays(day, 1);
  // The newest first, as the overview lists the day's records.
  const cards = cardsBetween(data, day, end);
  const exams = data.exams.filter((x) => x.submittedAt >= day && x.submittedAt < end).sort((a, b) => b.submittedAt - a.submittedAt);
  const [typed, setTyped] = useState(ymd(day));
  useEffect(() => setTyped(ymd(day)), [day]);
  const jump = () => {
    const at = parseDay(typed);
    if (at !== undefined) go(`/records?day=${ymd(at)}`);
  };

  return (
    <>
      <PageHead title="Checklists and exams" lede="Everyone’s equipment checklists and pre shift exams, by the day they were signed." />
      <div className="records">
        <nav aria-label="Days with records" className="stack" style={{ gap: '0.75rem' }}>
          <form className="day-picker" onSubmit={(e) => { e.preventDefault(); jump(); }}>
            <TextField label="Go to a day" type="date" value={typed} onChange={setTyped} />
            <Button kind="ink" type="submit">Show the day</Button>
          </form>
          <ul className="days">
            {days.slice(0, 60).map((d) => (
              <li key={d.day}>
                <A href={`/records?day=${ymd(d.day)}`} current={d.day === day}>
                  <strong>{fmtDate(d.day)}</strong>
                  <span className="muted small">{count(d.checklists, 'checklist')}, {count(d.exams, 'exam')}</span>
                </A>
              </li>
            ))}
            {days.length === 0 ? <li className="ledger-empty">No records have arrived yet.</li> : null}
          </ul>
        </nav>

        <div className="stack-lg">
          <h2 className="h2">{fmtDateLong(day)}, {new Date(day).getFullYear()}</h2>
          <section className="section" aria-labelledby="cards-title">
            <h3 className="h3" id="cards-title">Equipment checklists</h3>
            <Ledger>
                <thead>
                  <tr>
                    <th scope="col">Operator</th>
                    <th scope="col">Equipment on the card</th>
                    <th scope="col">First signed</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card) => {
                    const first = card.columns[0].inspection;
                    const worst = card.columns.some((c) => c.inspection.result === 'bad_order') ? 'bad_order' : card.columns.some((c) => c.inspection.result === 'defect') ? 'defect' : 'pass';
                    return (
                      <tr key={`${card.employeeId}-${first.id}`} className={worst === 'bad_order' ? 'danger-row' : undefined}>
                        <th scope="row"><A className="rowlink" href={`/checklists/${encodeURIComponent(first.id)}`}>{people.name(card.employeeId)}</A></th>
                        <td>
                          <span className="row" style={{ gap: '0.4rem' }}>
                            {card.columns.map((c) => (
                              <A key={c.inspection.id} href={`/checklists/${encodeURIComponent(c.inspection.id)}`} className="plate">{c.unit?.unit ?? 'Removed'}</A>
                            ))}
                          </span>
                        </td>
                        <td className="nowrap num">{fmtTime(first.submittedAt)}</td>
                        <td>{worst === 'pass' ? <span className="tag tag-ok">Passed</span> : worst === 'bad_order' ? <span className="tag tag-bo-solid">Red tagged</span> : <span className="tag tag-warn">Defect reported</span>}</td>
                      </tr>
                    );
                  })}
                  {cards.length === 0 ? <tr><td colSpan={4} className="ledger-empty">No equipment checklist was signed this day.</td></tr> : null}
                </tbody>
              </Ledger>
          </section>

          <section className="section" aria-labelledby="exams-title">
            <h3 className="h3" id="exams-title">Pre shift exams</h3>
            <Ledger>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Shift</th>
                    <th scope="col">Examined by</th>
                    <th scope="col">Signed</th>
                    <th scope="col" className="r">Lines</th>
                    <th scope="col" className="r">Found</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {exams.map((x) => {
                    const result = examResult(x);
                    const found = examFindings(x);
                    return (
                      <tr key={x.id} className={result === 'danger' ? 'danger-row' : undefined}>
                        <th scope="row"><A className="rowlink" href={`/exams/${encodeURIComponent(x.id)}`}>{x.area}</A></th>
                        <td>{shiftLabel(x.shift)}</td>
                        <td className="nowrap">{people.name(x.employeeId)}</td>
                        <td className="nowrap num">{fmtTime(x.submittedAt)}</td>
                        <td className="r num">{examCounts(x).lines}</td>
                        <td className="r num">{found.length}</td>
                        <td>{result === 'clear' ? <span className="tag tag-ok">Clear</span> : result === 'danger' ? <span className="tag tag-bo-solid">Danger</span> : <span className="tag tag-warn">Conditions found</span>}</td>
                      </tr>
                    );
                  })}
                  {exams.length === 0 ? <tr><td colSpan={7} className="ledger-empty">No pre shift exam was signed this day.</td></tr> : null}
                </tbody>
              </Ledger>
          </section>
        </div>
      </div>
    </>
  );
}

const STANDARDS_NOTE = 'Standards are cited from 30 CFR and 29 CFR for reference. The app’s summaries of them are plain language, not legal advice.';

/** One person's card for the day, opened at the checklist asked for. */
export function ChecklistPage({ id }: { id: string }) {
  const ctx = useCompany();
  const people = usePeople();
  const { data, company } = ctx.shaped;
  const inspection = data.inspections.find((i) => i.id === id);
  if (!inspection) {
    return (
      <>
        <PageHead title="Checklist not found" crumb={<A href="/records">Checklists and exams</A>} />
        <Notice tone="info">This equipment checklist is not among the records on the server. <A href="/records">See the day’s records</A>.</Notice>
      </>
    );
  }
  const card = dailyCards(data, inspection.employeeId, inspection.submittedAt).find((c) => c.columns.some((col) => col.inspection.id === id))!;
  const clock = keepsTime(company) ? dayClock(data.shifts, inspection.employeeId, inspection.submittedAt, ctx.now) : undefined;
  const unit = people.unitOf.get(inspection.equipmentId);
  const template = checklistFor(unit?.category ?? 'loader');
  const earlier = !onTheCard(inspection);
  const mrf = inspection.mrfId ? people.mrfOf.get(inspection.mrfId) : undefined;
  const log = data.opLogs.find((l) => l.inspectionId === inspection.id);
  const bad = inspection.answers.filter((a) => a.answer === 'bo');
  const doubt = people.doubtOf.get(`inspection:${inspection.id}`);
  const sender = people.sentFrom('inspection', inspection.id);

  return (
    <>
      <PageHead
        title={`${unit?.unit ?? 'Removed unit'}, ${people.name(inspection.employeeId)}`}
        crumb={<><A href={`/records?day=${ymd(inspection.submittedAt)}`}>Checklists and exams, {fmtDateLong(inspection.submittedAt)}</A></>}
        lede={`Operator equipment checklist signed ${fmtDateTime(inspection.submittedAt)}. Shown as it was signed.`}
      />
      {doubt ? <Notice tone="warn" title="Check who sent it">{doubt.why}. The server takes a crew member’s checklist for anyone in the company.</Notice> : null}
      <div className="split">
        <div className="desk">
          <ChecklistCardSheet card={card} name={people.name(inspection.employeeId)} clock={clock} current={inspection.id} hrefFor={(x) => `/checklists/${encodeURIComponent(x)}`} />
          <p className="paper-note">The highlighted line is this checklist. The others are the same person’s other units that day, as the card numbers them.</p>
        </div>
        <div className="stack-lg split-first">
          <section className="section" aria-labelledby="this-title">
            <h2 className="h2" id="this-title">This checklist</h2>
            <dl className="facts">
              <div><dt>Unit</dt><dd>{unit ? <><span className="plate">{unit.unit}</span> {unit.make} {unit.model}</> : 'Removed from fleet'}</dd></div>
              {unit ? <div><dt>Type</dt><dd>{CATEGORY_LABEL[unit.category]}</dd></div> : null}
              <div><dt>Result</dt><dd>{inspection.result === 'pass' ? 'Passed' : inspection.result === 'bad_order' ? <span className="tag tag-bo-solid">Red tagged</span> : <span className="tag tag-warn">Defect reported</span>}</dd></div>
              <div><dt>Started</dt><dd>{fmtDateTime(inspection.startedAt)}</dd></div>
              <div><dt>Signed</dt><dd>{fmtDateTime(inspection.submittedAt)}</dd></div>
              <div><dt>{unit?.meterUnit === 'mi' ? 'Odometer at the check' : 'Equipment hours at the check'}</dt><dd>{fmtMeter(inspection.meter)}</dd></div>
              {log?.endMeter != null ? <div><dt>At the end of use</dt><dd>{fmtMeter(log.endMeter)}{log.endAt ? `, ${fmtDateTime(log.endAt)}` : ''}</dd></div> : null}
              {log && log.endAt == null ? <div><dt>Use</dt><dd>Still in use</dd></div> : null}
              {inspection.decision ? <div><dt>After the defect</dt><dd>{inspection.decision === 'operate' ? 'Ran it after a supervisor cleared it' : 'Parked it'}</dd></div> : null}
              {mrf ? <div><dt>Maintenance request</dt><dd><A href={`/requests/${encodeURIComponent(mrf.id)}`}>#{mrf.number}</A>, {mrf.status === 'completed' ? 'completed' : mrf.status === 'in_progress' ? 'in progress' : 'open'}</dd></div> : null}
              {sender ? <div><dt>Sent from</dt><dd>{sender.row ? `${sender.name}${sender.supervisor ? ', supervisor' : ''}` : 'An account not on the sign-in roster'}</dd></div> : null}
            </dl>
          </section>
          {bad.length ? (
            <section className="section" aria-labelledby="bo-title">
              <h2 className="h2" id="bo-title">Bad Orders</h2>
              <ul className="daylist">
                {bad.map((a) => {
                  const item = earlier ? undefined : findItem(template, a.itemId);
                  const cited = !!unit && !!(standard(item?.cfr) || standard(item?.osha));
                  const hazard = isHazard(template, a);
                  return (
                    <li key={a.itemId} style={{ padding: '0.65rem 0.9rem', background: hazard ? 'var(--red-tint)' : undefined }}>
                      <strong>{earlier ? 'Earlier checklist' : (item?.label ?? a.itemId)}</strong>
                      {hazard ? <> <span className="tag tag-bo-solid">Red tagged</span></> : null}
                      {a.note ? <p>{a.note}</p> : null}
                      <p className="small muted">{cited ? <Cites keys={[item?.cfr, item?.osha]} /> : 'No standard cited for this line on this type of machine.'}</p>
                    </li>
                  );
                })}
              </ul>
              <p className="small muted">{STANDARDS_NOTE}</p>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function ExamPage({ id }: { id: string }) {
  const ctx = useCompany();
  const people = usePeople();
  const exam = ctx.shaped.data.exams.find((x) => x.id === id);
  if (!exam) {
    return (
      <>
        <PageHead title="Exam not found" crumb={<A href="/records">Checklists and exams</A>} />
        <Notice tone="info">This pre shift exam is not among the records on the server. <A href="/records">See the day’s records</A>.</Notice>
      </>
    );
  }
  const counts = examCounts(exam);
  const found = examFindings(exam);
  const dangers = found.filter((f) => f.danger && !f.fixed);
  const doubt = people.doubtOf.get(`exam:${exam.id}`);
  const sender = people.sentFrom('exam', exam.id);
  return (
    <>
      <PageHead
        title={`${exam.area}, ${shiftLabel(exam.shift).toLowerCase()} shift`}
        crumb={<A href={`/records?day=${ymd(exam.submittedAt)}`}>Checklists and exams, {fmtDateLong(exam.submittedAt)}</A>}
        lede={`Pre shift exam by ${people.name(exam.employeeId)}, signed ${fmtDateTime(exam.submittedAt)}. Shown with the lines and labels it was made on.`}
      />
      <DangerBand dangers={dangers} nameOf={people.name} linked={false} />
      {doubt ? <Notice tone="warn" title="Check who sent it">{doubt.why}. The server takes a crew member’s exam for anyone in the company.</Notice> : null}
      <div className="split">
        <ExamPaper
          exam={exam}
          examiner={people.name(exam.employeeId)}
          nameOf={people.name}
          mrfNumber={(m) => people.mrfOf.get(m)?.number}
          mrfHref={(m) => `/requests/${encodeURIComponent(m)}`}
        />
        <div className="stack-lg split-first">
          <section className="section" aria-labelledby="exam-facts">
            <h2 className="h2" id="exam-facts">This exam</h2>
            <dl className="facts">
              <div><dt>Started</dt><dd>{fmtDateTime(exam.startedAt)}</dd></div>
              <div><dt>Signed</dt><dd>{fmtDateTime(exam.submittedAt)}</dd></div>
              <div><dt>Lines</dt><dd>{counts.lines}</dd></div>
              <div><dt>OK</dt><dd>{counts.ok}</dd></div>
              <div><dt>Bad Order</dt><dd>{counts.bo}</dd></div>
              <div><dt>N/A</dt><dd>{counts.na}</dd></div>
              <div><dt>Still open</dt><dd>{found.filter((f) => !f.fixed).length}</dd></div>
              {sender ? <div><dt>Sent from</dt><dd>{sender.row ? `${sender.name}${sender.supervisor ? ', supervisor' : ''}` : 'An account not on the sign-in roster'}</dd></div> : null}
            </dl>
            {exam.single ? <p className="small muted">This area’s sheet has one OK/BO column for each line, so its lines have no guarding, electrical and safe access columns.</p> : null}
          </section>
          {found.length ? (
            <section className="section" aria-labelledby="found-title">
              <h2 className="h2" id="found-title">What was found</h2>
              <ul className="daylist">
                {found.map((f) => (
                  <li key={f.key} style={{ padding: '0.65rem 0.9rem', background: f.danger && !f.fixed ? 'var(--red-tint)' : undefined }}>
                    <strong>{f.label}</strong> <span className="small muted">{f.where}</span>
                    {f.note ? <p className="small">{f.note}</p> : null}
                    {f.refs.some((r) => standard(r)) ? <p className="small muted"><Cites keys={f.refs} /></p> : null}
                    <p className="small" style={{ color: f.fixed ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {f.fixed ? `Fixed ${fmtDateTime(f.fixed.at)} by ${people.name(f.fixed.by)}` : f.danger ? 'Danger. Open until a date fixed is recorded.' : 'Open until a date fixed is recorded.'}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="small muted">{STANDARDS_NOTE}</p>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
