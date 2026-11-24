import { examFindings } from '@app/domain/areaExam';
import type { Mrf, MrfEvent, MrfPriority, MrfStatus } from '@app/domain/types';
import { fmtDate, fmtDateTime, fmtMeter } from '@app/util/format';

import { useCompany } from '../lib/company';
import { go } from '../lib/router';
import { daysOpen, fmtDays, openRequests } from '../lib/overview';
import { A, Ledger, Notice, Seg, type Tone } from '../ui/kit';
import { MrfPaper } from '../ui/paper';
import { usePeople } from '../ui/people';
import { PageHead } from './Shell';

/*
 * Red is kept for a Bad Order, a red tag and a danger. A request that red tagged
 * its unit carries the "Red tagged" mark of its own; its status and priority do not
 * need red to say so.
 */
export const MRF_STATUS: Record<MrfStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'ok' },
};

export const MRF_PRIORITY: Record<MrfPriority, { label: string; tone: Tone | 'ink' }> = {
  safety: { label: 'Safety', tone: 'ink' },
  high: { label: 'High', tone: 'warn' },
  routine: { label: 'Routine', tone: 'neutral' },
};

/** A status or priority the app does not have is shown as it was sent, never left to stop the page. */
export const statusOf = (status: string) => MRF_STATUS[status as MrfStatus] ?? { label: status, tone: 'neutral' as Tone };
export const priorityOf = (priority: string) => MRF_PRIORITY[priority as MrfPriority] ?? { label: priority, tone: 'neutral' as Tone };

/** A request's number, and when two phones gave out the same one, which of the two this is. */
export function RequestNumber({ mrf, repeated, href }: { mrf: Mrf; repeated: Map<number, Mrf[]>; href?: string }) {
  const twice = repeated.has(mrf.number);
  return (
    <>
      {href ? <A className="rowlink num" href={href}>{mrf.number}</A> : <span className="num">{mrf.number}</span>}
      {twice ? <span className="under">Number given twice. This one sent {fmtDate(mrf.createdAt)}.</span> : null}
    </>
  );
}

const HISTORY_LABEL: Record<string, string> = { open: 'Request sent', in_progress: 'Work started', completed: 'Completed' };

type Show = 'open' | 'in_progress' | 'completed' | 'all';
const SHOWS: { value: Show; label: string }[] = [
  { value: 'open', label: 'Not completed' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const openFor = (m: Mrf, now: number) => fmtDays(daysOpen(m.createdAt, m.completedAt ?? now));

export function RequestsPage({ show: asked }: { show: string | null }) {
  const ctx = useCompany();
  const people = usePeople();
  const show = (SHOWS.find((s) => s.value === asked)?.value ?? 'open') as Show;
  const all = ctx.shaped.data.mrfs;
  const list =
    show === 'open'
      ? openRequests(all)
      : show === 'in_progress'
        ? openRequests(all).filter((m) => m.status === 'in_progress')
        : show === 'completed'
          ? all.filter((m) => m.status === 'completed').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
          : [...all].sort((a, b) => b.number - a.number);

  return (
    <>
      <PageHead
        title="Maintenance requests"
        lede="Every request the crew has sent, with the fields of the paper form. A request is assigned, started and completed in the app."
      />
      <div className="row">
        <Seg label="Which requests" value={show} onChange={(v) => go(v === 'open' ? '/requests' : `/requests?show=${v}`, { replace: true })} options={SHOWS} />
        <span className="muted small">{list.length} shown</span>
      </div>
      <Ledger>
          <thead>
            <tr>
              <th scope="col" className="r">MRF #</th>
              <th scope="col">Date</th>
              <th scope="col">By</th>
              <th scope="col">Problem</th>
              <th scope="col">Priority</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned to</th>
              <th scope="col" className="r">Days open</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const unit = m.equipmentId ? people.unitOf.get(m.equipmentId) : undefined;
              return (
                <tr key={m.id}>
                  <th scope="row" className="r"><RequestNumber mrf={m} repeated={people.repeated} href={`/requests/${encodeURIComponent(m.id)}`} /></th>
                  <td className="nowrap">{fmtDateTime(m.createdAt)}</td>
                  <td className="nowrap">{people.name(m.requestedBy)}</td>
                  <td className="wrap">
                    {m.equipmentId ? <strong className="cond">{unit?.unit ?? 'Removed unit'} </strong> : null}
                    {m.description}
                    {m.location ? <span className="under">Location: {m.location}</span> : null}
                    {m.taggedOut && m.status !== 'completed' ? <> <span className="tag tag-bo">Red tagged</span></> : null}
                  </td>
                  <td><span className={`tag tag-${priorityOf(m.priority).tone}`}>{priorityOf(m.priority).label}</span></td>
                  <td><span className={`tag tag-${statusOf(m.status).tone}`}>{statusOf(m.status).label}</span></td>
                  <td className="nowrap">{m.assignedTo ? people.name(m.assignedTo) : <span className="muted">Not assigned</span>}</td>
                  <td className="r num">{openFor(m, ctx.now)}</td>
                </tr>
              );
            })}
            {list.length === 0 ? (
              <tr>
                <td colSpan={8} className="ledger-empty">
                  {all.length === 0
                    ? 'No maintenance requests have been sent yet. They arrive here when the crew sends them from the app.'
                    : show === 'open'
                      ? 'Every maintenance request is completed.'
                      : show === 'in_progress'
                        ? 'No request is in progress.'
                        : 'No request is completed yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </Ledger>
    </>
  );
}

export function RequestPage({ id }: { id: string }) {
  const ctx = useCompany();
  const people = usePeople();
  const mrf = ctx.shaped.data.mrfs.find((m) => m.id === id);
  if (!mrf) {
    return (
      <>
        <PageHead title="Request not found" crumb={<A href="/requests">Maintenance requests</A>} />
        <Notice tone="info">This request is not among the records on the server. It may have been taken off a phone. <A href="/requests">See every request</A>.</Notice>
      </>
    );
  }
  const unit = mrf.equipmentId ? people.unitOf.get(mrf.equipmentId) : undefined;
  const done = mrf.status === 'completed';
  const exam = mrf.examId ? ctx.shaped.data.exams.find((x) => x.id === mrf.examId) : undefined;
  const finding = exam && mrf.findingKey ? examFindings(exam).find((f) => f.key === mrf.findingKey) : undefined;
  const check = mrf.inspectionId ? ctx.shaped.data.inspections.find((i) => i.id === mrf.inspectionId) : undefined;
  const event = (e: MrfEvent) => (e.assignedTo ? `Assigned to ${people.name(e.assignedTo)}` : HISTORY_LABEL[e.status] ?? e.status);
  const twins = (people.repeated.get(mrf.number) ?? []).filter((m) => m.id !== mrf.id);
  const doubt = people.doubtOf.get(`mrf:${mrf.id}`);
  const sender = people.sentFrom('mrf', mrf.id);

  return (
    <>
      <PageHead
        title={`Request #${mrf.number}`}
        crumb={<A href="/requests">Maintenance requests</A>}
        lede={`Sent ${fmtDateTime(mrf.createdAt)} by ${people.name(mrf.requestedBy)}.`}
      />
      <div className="row">
        <span className={`tag tag-${statusOf(mrf.status).tone}`}>{statusOf(mrf.status).label}</span>
        <span className={`tag tag-${priorityOf(mrf.priority).tone}`}>{priorityOf(mrf.priority).label} priority</span>
        {mrf.taggedOut ? <span className={done ? 'tag' : 'tag tag-bo-solid'}>{done ? 'Was red tagged' : 'Red tagged'}</span> : null}
      </div>
      {mrf.taggedOut && !done ? (
        <Notice tone="bo" title="Red tagged">The unit is out of service, and is not to be operated, until this request is completed.</Notice>
      ) : null}
      {twins.length ? (
        <Notice tone="warn" title={`Another request has the same number, #${mrf.number}`}>
          Each phone numbers its own requests, so two phones can give out the same number. The other:{' '}
          {twins.map((m, i) => (
            <span key={m.id}>
              {i ? '; ' : ''}
              <A href={`/requests/${encodeURIComponent(m.id)}`}>sent {fmtDateTime(m.createdAt)} by {people.name(m.requestedBy)}{m.equipmentId ? `, unit ${people.unitOf.get(m.equipmentId)?.unit ?? 'since removed'}` : ''}</A>
            </span>
          ))}
          . Tell them apart by the date and the unit.
        </Notice>
      ) : null}
      {doubt ? <Notice tone="warn" title="Check who completed it">{doubt.why}. The server takes the work on a request assigned to someone from any member’s account; on one nobody is assigned to, only a supervisor’s.</Notice> : null}
      <div className="split">
        <div className="desk">
          <MrfPaper mrf={mrf} unit={unit} nameOf={people.name} />
          <p className="paper-note">The request as it stands on the server. It is assigned, started and completed in the MineMuster app; completing a request that came from a pre shift exam records the date fixed on that exam.</p>
        </div>
        <div className="stack-lg">
          {unit || check || finding || sender ? (
            <section className="section" aria-labelledby="from-title">
              <h2 className="h2" id="from-title">Where it came from</h2>
              <dl className="facts">
                {unit ? <div><dt>Unit</dt><dd><span className="plate">{unit.unit}</span> {unit.make} {unit.model}</dd></div> : null}
                {mrf.meter != null && unit ? <div><dt>{unit.meterUnit === 'mi' ? 'Odometer' : 'Equipment hours'} when sent</dt><dd>{fmtMeter(mrf.meter)}</dd></div> : null}
                {check ? <div><dt>Equipment checklist</dt><dd><A href={`/checklists/${encodeURIComponent(check.id)}`}>{fmtDateTime(check.submittedAt)}</A></dd></div> : null}
                {sender ? <div><dt>Latest version sent from</dt><dd>{sender.row ? `${sender.name}${sender.supervisor ? ', supervisor' : ''}` : 'An account not on the sign-in roster'}</dd></div> : null}
                {exam && finding ? (
                  <div><dt>Pre shift exam</dt><dd><A href={`/exams/${encodeURIComponent(exam.id)}`}>{exam.area}, {fmtDateTime(exam.submittedAt)}</A><br /><span className="small muted">{finding.label}{finding.fixed ? `, fixed ${fmtDateTime(finding.fixed.at)}` : ', still open'}</span></dd></div>
                ) : null}
              </dl>
            </section>
          ) : null}
          {mrf.items.length ? (
            <section className="section" aria-labelledby="items-title">
              <h2 className="h2" id="items-title">Lines it was sent for</h2>
              <dl className="facts">
                {mrf.items.map((item, i) => (
                  <div key={i}><dt>{item.label}</dt><dd>{item.note ?? ''}</dd></div>
                ))}
              </dl>
            </section>
          ) : null}
          <section className="section" aria-labelledby="hist-title">
            <h2 className="h2" id="hist-title">History</h2>
            {mrf.history.length ? (
              <ol className="daylist">
                {mrf.history.map((e, i) => (
                  <li key={i} style={{ padding: '0.6rem 0.9rem' }}>
                    <strong>{event(e)}</strong>
                    <span className="small muted" style={{ display: 'block' }}>{fmtDateTime(e.at)}, entered by {people.name(e.by)}</span>
                    {e.note ? <p className="small" style={{ marginTop: '0.2rem' }}>{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No history on this request.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
