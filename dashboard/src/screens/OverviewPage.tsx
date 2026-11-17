import { examResult, shiftLabel } from '@app/domain/areaExam';
import { keepsTime } from '@app/domain/company';
import { fmtDateTime, fmtTime, ymd } from '@app/util/format';

import { useCompany } from '../lib/company';
import { withStop } from '../lib/joinStatus';
import { redTagSource } from '../lib/overview';
import { KIND_WORDS, type Doubt } from '../lib/provenance';
import { phonesNotOnRoster } from '../lib/rosterTools';
import { DangerBand } from '../ui/danger';
import { A, count, Ledger, Notice } from '../ui/kit';
import { usePeople } from '../ui/people';
import { PageHead } from './Shell';
import { priorityOf, RequestNumber, statusOf } from './RequestsPage';

/** What a supervisor reads first: what is open, a danger ahead of anything else, and what came in today. */
export function OverviewPage() {
  const ctx = useCompany();
  const { board, shaped, roster, requests } = ctx;
  const people = usePeople();
  const pending = requests.filter((r) => r.status === 'pending').length;
  const joined = roster.filter((r) => r.active && r.user_id).length;
  const onRoster = roster.filter((r) => r.active).length;
  const notOn = phonesNotOnRoster(shaped.data.employees, roster, shaped.placeholders).length;
  const safety = board.requests.filter((m) => m.priority === 'safety').length;

  const repeated = [...people.repeated.keys()];
  const doubts = people.doubts;

  const rosterFacts = (
    <section className="section" aria-labelledby="roster-title">
      <div className="section-head">
        <h2 className="h2" id="roster-title">Roster</h2>
        <A href="/roster">Open the roster</A>
      </div>
      <dl className="facts">
        <div><dt>On the sign-in roster</dt><dd>{onRoster}</dd></div>
        <div><dt>Joined with their own account</dt><dd>{joined}</dd></div>
        <div><dt>Join requests waiting</dt><dd>{pending ? <A href="/roster">{pending}</A> : 0}</dd></div>
        <div><dt>On the phones, not on the sign-in roster</dt><dd>{notOn}</dd></div>
      </dl>
    </section>
  );

  if (ctx.recordsError) {
    return (
      <>
        <PageHead title="Overview" lede={`${withStop(`The roster of ${shaped.company.name || ctx.choice.name}`)} What is open shows here once the records load.`} />
        <div style={{ maxWidth: '36rem' }}>{rosterFacts}</div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Overview" lede={`What is open at ${shaped.company.name || ctx.choice.name}, and what came in today.`} />

      {!shaped.lastArrived ? (
        <Notice tone="info" title="No records have arrived from the phones yet">
          They come in once the crew’s phones are connected. Put the crew on the <A href="/roster">roster</A> and give them the join code. Each person then opens More → Company account in the MineMuster app, signs in and joins with the code. Their checklists, exams, requests{keepsTime(shaped.company) ? ' and hours' : ''} arrive here whenever the phone has signal.
        </Notice>
      ) : null}

      <DangerBand dangers={board.dangers} nameOf={people.name} />

      <nav className="tally" aria-label="Open now">
        <TallyLink
          href="/defects"
          n={board.redTagged.length}
          what={board.redTagged.length === 1 ? 'unit red tagged' : 'units red tagged'}
          sub={board.defect.length ? `${board.defect.length} more with a defect reported` : board.redTagged.length ? 'Out of service until repaired' : undefined}
          hot={board.redTagged.length > 0}
        />
        <TallyLink href="/defects" n={board.badOrders.length} what={board.badOrders.length === 1 ? 'Bad Order not corrected' : 'Bad Orders not corrected'} sub="On equipment checklists" />
        <TallyLink
          href="/defects#conditions"
          n={board.conditions.length}
          what={board.conditions.length === 1 ? 'condition open' : 'conditions open'}
          sub={board.dangers.length ? `${count(board.dangers.length, 'danger')} among them` : 'From pre shift exams'}
          hot={board.dangers.length > 0}
        />
        <TallyLink
          href="/requests"
          n={board.requests.length}
          what={board.requests.length === 1 ? 'maintenance request open' : 'maintenance requests open'}
          sub={safety ? `${safety} for safety` : 'None for safety'}
        />
      </nav>

      <div className="split">
        <div className="stack-lg">
          <section className="section" aria-labelledby="tagged-title">
            <div className="section-head">
              <h2 className="h2" id="tagged-title">Red tagged</h2>
              <span className="section-note">A unit stays out of service until its maintenance request is completed.</span>
            </div>
            {board.redTagged.length ? (
              <ul className="tags">
                {board.redTagged.map((unit) => {
                  // What keeps the tag on: its open request, and the checklist it came from when there is one.
                  const tag = redTagSource(unit, shaped.data);
                  const href = tag.inspectionId ? `/checklists/${encodeURIComponent(tag.inspectionId)}` : tag.mrfId ? `/requests/${encodeURIComponent(tag.mrfId)}` : undefined;
                  const body = (
                    <>
                      <span className="redtag-band" aria-hidden="true">DANGER</span>
                      <span className="redtag-body">
                        <span className="redtag-dno" aria-hidden="true">DO NOT OPERATE</span>
                        <span className="redtag-unit">{unit.unit}</span>
                        <span className="redtag-what">{unit.make} {unit.model}</span>
                        {tag.at ? <span className="redtag-what">Tagged {fmtDateTime(tag.at)}</span> : null}
                      </span>
                    </>
                  );
                  return (
                    <li key={unit.id}>
                      {href ? (
                        <A href={href} className="redtag">
                          <span className="sr-only">Red tagged, do not operate: </span>{body}
                        </A>
                      ) : (
                        <span className="redtag">{body}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">No unit is red tagged.</p>
            )}
          </section>

          <section className="section" aria-labelledby="cond-title">
            <div className="section-head">
              <h2 className="h2" id="cond-title">Open conditions</h2>
              {board.conditions.length > 6 ? <A href="/defects#conditions">All {board.conditions.length}</A> : null}
            </div>
            <Ledger>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Line</th>
                    <th scope="col">What was wrong</th>
                    <th scope="col">Found</th>
                  </tr>
                </thead>
                <tbody>
                  {board.conditions.slice(0, 6).map((f) => (
                    <tr key={`${f.examId}:${f.key}`} className={f.danger ? 'danger-row' : undefined}>
                      <th scope="row"><A className="rowlink" href={`/exams/${encodeURIComponent(f.examId)}`}>{f.area}</A></th>
                      <td>{f.label}{f.danger ? <> <span className="tag tag-bo-solid">Danger</span></> : null}</td>
                      <td className="wrap">{f.note}</td>
                      <td className="nowrap">{fmtDateTime(f.foundAt)}</td>
                    </tr>
                  ))}
                  {board.conditions.length === 0 ? (
                    <tr><td colSpan={4} className="ledger-empty">No condition from a pre shift exam is open.</td></tr>
                  ) : null}
                </tbody>
              </Ledger>
          </section>

          <section className="section" aria-labelledby="req-title">
            <div className="section-head">
              <h2 className="h2" id="req-title">Open maintenance requests</h2>
              {board.requests.length > 6 ? <A href="/requests">All {board.requests.length}</A> : null}
            </div>
            <Ledger>
                <thead>
                  <tr>
                    <th scope="col" className="r">No.</th>
                    <th scope="col">Problem</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Assigned to</th>
                  </tr>
                </thead>
                <tbody>
                  {board.requests.slice(0, 6).map((m) => (
                    <tr key={m.id}>
                      <th scope="row" className="r"><RequestNumber mrf={m} repeated={people.repeated} href={`/requests/${encodeURIComponent(m.id)}`} /></th>
                      <td className="wrap">
                        {m.equipmentId ? <strong className="cond">{people.unitOf.get(m.equipmentId)?.unit ?? 'Removed unit'} </strong> : null}
                        {m.description}
                        {m.taggedOut ? <> <span className="tag tag-bo">Red tagged</span></> : null}
                      </td>
                      <td><span className={`tag tag-${priorityOf(m.priority).tone}`}>{priorityOf(m.priority).label}</span></td>
                      <td>{m.assignedTo ? people.name(m.assignedTo) : <span className="muted">{statusOf(m.status).label}, not assigned</span>}</td>
                    </tr>
                  ))}
                  {board.requests.length === 0 ? (
                    <tr><td colSpan={4} className="ledger-empty">{shaped.data.mrfs.length ? 'Every maintenance request is completed.' : 'No maintenance requests have been sent yet.'}</td></tr>
                  ) : null}
                </tbody>
              </Ledger>
          </section>
        </div>

        <div className="stack-lg">
          <section className="section" aria-labelledby="today-title">
            <div className="section-head">
              <h2 className="h2" id="today-title">Today</h2>
              <A href={`/records?day=${ymd(ctx.now)}`}>The day’s records</A>
            </div>
            <h3 className="h3">Equipment checklists</h3>
            {board.today.inspections.length ? (
              <ul className="daylist">
                {board.today.inspections.slice(0, 8).map((i) => {
                  const unit = people.unitOf.get(i.equipmentId);
                  return (
                    <li key={i.id}>
                      <A href={`/checklists/${encodeURIComponent(i.id)}`}>
                        <span className="when">{fmtTime(i.submittedAt)}</span>
                        <span className="who">
                          <strong>{people.name(i.employeeId)}</strong>
                          <span>{unit ? `${unit.unit}, ${unit.make} ${unit.model}` : 'A unit since removed'}</span>
                        </span>
                        {i.result === 'pass' ? <span className="tag tag-ok">Passed</span> : i.result === 'bad_order' ? <span className="tag tag-bo-solid">Red tagged</span> : <span className="tag tag-warn">Defect reported</span>}
                      </A>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">None signed yet today.</p>
            )}
            {board.today.inspections.length > 8 ? <p className="small"><A href={`/records?day=${ymd(ctx.now)}`}>{board.today.inspections.length - 8} more today</A></p> : null}
            <h3 className="h3">Pre shift exams</h3>
            {board.today.exams.length ? (
              <ul className="daylist">
                {board.today.exams.slice(0, 8).map((x) => {
                  const result = examResult(x);
                  return (
                    <li key={x.id}>
                      <A href={`/exams/${encodeURIComponent(x.id)}`}>
                        <span className="when">{fmtTime(x.submittedAt)}</span>
                        <span className="who">
                          <strong>{x.area}, {shiftLabel(x.shift).toLowerCase()} shift</strong>
                          <span>{people.name(x.employeeId)}</span>
                        </span>
                        {result === 'clear' ? <span className="tag tag-ok">Clear</span> : result === 'danger' ? <span className="tag tag-bo-solid">Danger</span> : <span className="tag tag-warn">Conditions found</span>}
                      </A>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">None signed yet today.</p>
            )}
          </section>

{rosterFacts}

          <section className="section" aria-labelledby="rec-title">
            <h2 className="h2" id="rec-title">Records on the server</h2>
            <dl className="facts">
              <div><dt>Last arrived</dt><dd>{shaped.lastArrived ? fmtDateTime(shaped.lastArrived.at) : 'None yet'}</dd></div>
              <div><dt>Equipment checklists</dt><dd>{shaped.counts.inspection.toLocaleString('en-US')}</dd></div>
              <div><dt>Pre shift exams</dt><dd>{shaped.counts.exam.toLocaleString('en-US')}</dd></div>
              <div><dt>Maintenance requests</dt><dd>{shaped.counts.mrf.toLocaleString('en-US')}</dd></div>
              {keepsTime(shaped.company) ? <div><dt>Shifts on the time clock</dt><dd>{shaped.counts.shift.toLocaleString('en-US')}</dd></div> : null}
            </dl>
            {repeated.length ? (
              <Notice tone="warn" title={`${repeated.length === 1 ? 'A request number was' : `${repeated.length} request numbers were`} given out twice`}>
                Each phone numbers its own maintenance requests, so two phones can give out the same number: {repeated.map((n) => `#${n}`).join(', ')}. The lists here say which is which by date and unit. The PDF and the safety log print the number as each phone sent it.
              </Notice>
            ) : null}
            {doubts.length ? (
              <Notice tone="warn" title={`${count(doubts.length, 'record')} sent from an account that is not the person’s own`}>
                <p>A crew member’s account sent a record for someone else, or completed a request it is not assigned to. The server takes them; check them with the people named. It may be one person using a coworker’s phone.</p>
                <ul className="small" style={{ marginTop: '0.4rem', display: 'grid', gap: '0.35rem' }}>
                  {bySender(doubts).slice(0, 4).map(({ sender, list }) => {
                    const newest = list[0];
                    const where = newest.kind === 'inspection' ? 'checklists' : newest.kind === 'exam' ? 'exams' : newest.kind === 'mrf' ? 'requests' : null;
                    return (
                      <li key={sender.account}>
                        <strong>{sender.row ? `From the account of ${sender.name}` : 'From an account not on the sign-in roster'}: {count(list.length, 'record')}.</strong>{' '}
                        The newest:{' '}
                        {where ? <A href={`/${where}/${encodeURIComponent(newest.id)}`}>{KIND_WORDS[newest.kind]}</A> : KIND_WORDS[newest.kind]}
                        {newest.personId ? ` for ${people.name(newest.personId)}` : ''}, {fmtDateTime(newest.at)}.
                      </li>
                    );
                  })}
                </ul>
              </Notice>
            ) : null}
            {shaped.skipped.length ? (
              <Notice tone="warn" title={`${count(shaped.skipped.length, 'record')} could not be read`}>
                They are not the shape the app writes, so they are left out of every list and export here. The first: {shaped.skipped[0].kind} {shaped.skipped[0].id}, {shaped.skipped[0].why}.
              </Notice>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}

/** Records sent from accounts not the person's own, by the account, the account with the most first. */
function bySender(found: Doubt[]): { sender: Doubt['sender']; list: Doubt[] }[] {
  const groups = new Map<string, { sender: Doubt['sender']; list: Doubt[] }>();
  for (const d of found) {
    const group = groups.get(d.sender.account) ?? { sender: d.sender, list: [] };
    group.list.push(d);
    groups.set(d.sender.account, group);
  }
  return [...groups.values()].sort((a, b) => b.list.length - a.list.length);
}

function TallyLink({ href, n, what, sub, hot }: { href: string; n: number; what: string; sub?: string; hot?: boolean }) {
  return (
    <A href={href} className={hot ? 'hot' : undefined}>
      <span className="tally-n">{n}</span>
      <span className="tally-what">{what}</span>
      {sub ? <span className="tally-sub">{sub}</span> : null}
    </A>
  );
}
