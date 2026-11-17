import { useEffect } from 'react';

import { examFindings } from '@app/domain/areaExam';
import { checklistFor, findItem, onTheCard } from '@app/domain/templates';
import { DAY, fmtDateTime } from '@app/util/format';

import { useCompany } from '../lib/company';
import { daysOpen, fmtDays } from '../lib/overview';
import { DangerBand, whereWords } from '../ui/danger';
import { A, Cites, Ledger } from '../ui/kit';
import { usePeople } from '../ui/people';
import { PageHead } from './Shell';

const RECENT_DAYS = 30;

/**
 * What is wrong and not fixed yet: Bad Orders on equipment checklists, and the
 * conditions found on pre shift exams, a danger ahead of everything else.
 * Nothing closes a condition except its own date fixed, recorded in the app.
 */
export function DefectsPage() {
  const ctx = useCompany();
  const people = usePeople();
  const { board, shaped, now } = ctx;
  const since = now - RECENT_DAYS * DAY;

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const fixedBadOrders = shaped.data.inspections
    .flatMap((i) => {
      const mrf = i.mrfId ? people.mrfOf.get(i.mrfId) : undefined;
      if (!(mrf?.status === 'completed' && mrf.completedAt != null && mrf.completedAt >= since)) return [];
      const unit = people.unitOf.get(i.equipmentId);
      const template = checklistFor(unit?.category ?? 'loader');
      return i.answers.filter((a) => a.answer === 'bo').map((a) => ({ i, a, mrf, unit, label: onTheCard(i) ? (findItem(template, a.itemId)?.label ?? a.itemId) : 'Earlier checklist' }));
    })
    .sort((x, y) => (y.mrf.completedAt ?? 0) - (x.mrf.completedAt ?? 0));

  const fixedConditions = shaped.data.exams
    .flatMap(examFindings)
    .filter((f) => f.fixed && f.fixed.at >= since)
    .sort((a, b) => (b.fixed?.at ?? 0) - (a.fixed?.at ?? 0));

  return (
    <>
      <PageHead title="Defects and conditions" lede="Every Bad Order and condition that is not corrected yet, a danger first. A condition stays open until its date fixed is recorded in the app." />

      <DangerBand dangers={board.dangers} nameOf={people.name} />

      {board.redTagged.length || board.defect.length ? (
        <section className="section" aria-labelledby="units-title">
          <h2 className="h2" id="units-title">Units down</h2>
          <Ledger>
              <thead><tr><th scope="col">Unit</th><th scope="col">Equipment</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {[...board.redTagged, ...board.defect].map((u) => (
                  <tr key={u.id} className={board.redTagged.includes(u) ? 'danger-row' : undefined}>
                    <th scope="row"><span className="plate">{u.unit}</span></th>
                    <td>{u.make} {u.model}</td>
                    <td>{board.redTagged.includes(u) ? <span className="tag tag-bo-solid">Red tagged</span> : <span className="tag tag-warn">Defect reported</span>}</td>
                  </tr>
                ))}
              </tbody>
            </Ledger>
        </section>
      ) : null}

      <section className="section" aria-labelledby="badorders" id="badorders-section">
        <div className="section-head">
          <h2 className="h2" id="badorders">Bad Orders on equipment checklists</h2>
          <span className="section-note">Open until the maintenance request it was sent on is completed (<span className="cite">30 CFR § 56.14100(d)</span>).</span>
        </div>
        <Ledger>
            <thead>
              <tr>
                <th scope="col">Found</th>
                <th scope="col">Unit</th>
                <th scope="col">Line</th>
                <th scope="col">Request</th>
                <th scope="col" className="r">Days open</th>
                <th scope="col">What was wrong</th>
                <th scope="col">Operator</th>
              </tr>
            </thead>
            <tbody>
              {board.badOrders.map((b) => {
                const item = onTheCard(b.inspection) ? findItem(checklistFor(b.unit?.category ?? 'loader'), b.answer.itemId) : undefined;
                return (
                  <tr key={b.key} className={b.hazard ? 'danger-row' : undefined}>
                    <td className="nowrap"><A className="rowlink" href={`/checklists/${encodeURIComponent(b.inspection.id)}`}>{fmtDateTime(b.inspection.submittedAt)}</A></td>
                    <th scope="row"><span className="plate">{b.unit?.unit ?? 'Removed'}</span></th>
                    <td>
                      {b.label}{b.hazard ? <> <span className="tag tag-bo-solid">Red tagged</span></> : null}
                      {b.unit && (item?.cfr || item?.osha) ? <span className="under"><Cites keys={[item?.cfr, item?.osha]} /></span> : null}
                    </td>
                    <td className="nowrap">{b.mrf ? <A href={`/requests/${encodeURIComponent(b.mrf.id)}`}>#{b.mrf.number}, {b.mrf.status === 'in_progress' ? 'in progress' : 'open'}</A> : <span className="tag tag-warn">None sent</span>}</td>
                    <td className="r num">{fmtDays(daysOpen(b.inspection.submittedAt, now))}</td>
                    <td className="wrap">{b.answer.note ?? ''}</td>
                    <td className="nowrap">{people.name(b.inspection.employeeId)}</td>
                  </tr>
                );
              })}
              {board.badOrders.length === 0 ? <tr><td colSpan={7} className="ledger-empty">No Bad Order on an equipment checklist is waiting to be corrected.</td></tr> : null}
            </tbody>
          </Ledger>
        {fixedBadOrders.length ? (
          <details>
            <summary className="reveal"><span>Corrected in the last {RECENT_DAYS} days ({fixedBadOrders.length})</span></summary>
            <Ledger style={{ marginTop: '0.75rem' }}>
                <thead><tr><th scope="col">Found</th><th scope="col">Unit</th><th scope="col">Line</th><th scope="col">What was wrong</th><th scope="col">Corrected</th></tr></thead>
                <tbody>
                  {fixedBadOrders.map(({ i, a, mrf, unit, label }) => (
                    <tr key={`${i.id}:${a.itemId}`}>
                      <td className="nowrap"><A className="rowlink" href={`/checklists/${encodeURIComponent(i.id)}`}>{fmtDateTime(i.submittedAt)}</A></td>
                      <th scope="row"><span className="plate">{unit?.unit ?? 'Removed'}</span></th>
                      <td>{label}</td>
                      <td className="wrap">{a.note ?? ''}</td>
                      <td className="nowrap"><A href={`/requests/${encodeURIComponent(mrf.id)}`}>#{mrf.number}</A>, {fmtDateTime(mrf.completedAt!)}</td>
                    </tr>
                  ))}
                </tbody>
              </Ledger>
          </details>
        ) : null}
      </section>

      <section className="section" aria-labelledby="conditions">
        <div className="section-head">
          <h2 className="h2" id="conditions">Conditions from pre shift exams</h2>
          <span className="section-note">Open until a date fixed is recorded on the exam (<span className="cite">30 CFR § 56.18002(c)</span>). The same line marked OK on a later exam does not close it.</span>
        </div>
        <Ledger>
            <thead>
              <tr>
                <th scope="col">Found</th>
                <th scope="col">Area</th>
                <th scope="col">Line</th>
                <th scope="col">Request</th>
                <th scope="col" className="r">Days open</th>
                <th scope="col">What was wrong</th>
                <th scope="col">Found by</th>
              </tr>
            </thead>
            <tbody>
              {board.conditions.map((f) => {
                const mrf = f.mrfId ? people.mrfOf.get(f.mrfId) : undefined;
                return (
                  <tr key={`${f.examId}:${f.key}`} className={f.danger ? 'danger-row' : undefined}>
                    <td className="nowrap"><A className="rowlink" href={`/exams/${encodeURIComponent(f.examId)}`}>{fmtDateTime(f.foundAt)}</A></td>
                    <th scope="row">{f.area}</th>
                    <td>
                      {f.label}{f.danger ? <> <span className="tag tag-bo-solid">Danger</span></> : null}
                      <span className="under">{whereWords(f.where).replace(/^./, (c) => c.toUpperCase())}</span>
                    </td>
                    <td className="nowrap">{mrf ? <A href={`/requests/${encodeURIComponent(mrf.id)}`}>#{mrf.number}</A> : <span className="tag tag-warn">None sent</span>}</td>
                    <td className="r num">{fmtDays(daysOpen(f.foundAt, now))}</td>
                    <td className="wrap">{f.note ?? ''}</td>
                    <td className="nowrap">{people.name(f.employeeId)}</td>
                  </tr>
                );
              })}
              {board.conditions.length === 0 ? <tr><td colSpan={7} className="ledger-empty">No condition from a pre shift exam is open.</td></tr> : null}
            </tbody>
          </Ledger>
        {fixedConditions.length ? (
          <details>
            <summary className="reveal"><span>Fixed in the last {RECENT_DAYS} days ({fixedConditions.length})</span></summary>
            <Ledger style={{ marginTop: '0.75rem' }}>
                <thead><tr><th scope="col">Found</th><th scope="col">Area</th><th scope="col">Line</th><th scope="col">Date fixed</th><th scope="col">Fixed by</th></tr></thead>
                <tbody>
                  {fixedConditions.map((f) => (
                    <tr key={`${f.examId}:${f.key}`}>
                      <td className="nowrap"><A className="rowlink" href={`/exams/${encodeURIComponent(f.examId)}`}>{fmtDateTime(f.foundAt)}</A></td>
                      <th scope="row">{f.area}</th>
                      <td>{f.label}</td>
                      <td className="nowrap">{fmtDateTime(f.fixed!.at)}</td>
                      <td className="nowrap">{people.name(f.fixed!.by)}{f.fixed!.note ? <span className="muted small">: {f.fixed!.note}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </Ledger>
          </details>
        ) : null}
        <p className="small muted">Standards are cited from 30 CFR and 29 CFR for reference. The app’s summaries of them are plain language, not legal advice.</p>
      </section>
    </>
  );
}
