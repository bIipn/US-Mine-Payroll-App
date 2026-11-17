import type { ReactNode } from 'react';

import { AREA_CONDITIONS, EXAM_COLUMNS, rowAnswer, shiftLabel } from '@app/domain/areaExam';
import { CARD_COLUMNS, type CardColumn, type DailyCard, type DayClock } from '@app/domain/checklistCard';
import { ANSWER_LEGEND, ANSWER_MARK, checklistFor, FUEL_LINE, onTheCard } from '@app/domain/templates';
import type { Answer, AreaExam, Equipment, ExamCondition, ExamRow, Mrf } from '@app/domain/types';
import { fmtDate, fmtDateTime, fmtHrs, fmtMeter } from '@app/util/format';

import { A } from './kit';

/**
 * A signed record laid out as the paper it replaces: a white sheet, ruled
 * boxes, and condensed capitals for every word printed on the form. What a
 * person wrote in is set in the ordinary text face, so the two tell apart.
 * The record is shown as it was signed: nothing here changes it.
 */

export function Sheet({ title, corner, children, label }: { title: string; corner?: string; children: ReactNode; label?: string }) {
  return (
    <article className="sheet" aria-label={label ?? title}>
      <h2 className="sheet-title">
        {title}
        {corner ? <span className="sheet-corner">{corner}</span> : null}
      </h2>
      {children}
    </article>
  );
}

export function Lines({ children }: { children: ReactNode }) {
  return <div className="lines">{children}</div>;
}

/** A printed label with what was written after it, on a ruled line. */
export function Line({ label, value, wide, tall }: { label: string; value?: ReactNode; wide?: boolean; tall?: boolean }) {
  return (
    <div className={['line', wide && 'line-wide', tall && 'line-tall'].filter(Boolean).join(' ')}>
      <span className="line-label printed">{label}</span>
      <span className="line-value written">{value || ' '}</span>
    </div>
  );
}

const SAY: Record<Answer, string> = { ok: 'OK', bo: 'Bad Order', na: 'Not applicable' };

/** OK, BO or N/A the way it is written in a box. A Bad Order is filled red. */
export function Mark({ answer }: { answer?: Answer }) {
  if (!answer) return null;
  return (
    <span className={`mk mk-${answer}`} title={SAY[answer]}>
      <span aria-hidden="true">{ANSWER_MARK[answer]}</span>
      <span className="sr-only">{SAY[answer]}</span>
    </span>
  );
}

// ---- The Operator Equipment Checklist card -----------------------------------------------------

/** 18 or 12.5, with no trailing zero. */
const gal = (n: number) => `${Math.round(n * 10) / 10} gal`;

/**
 * A day's Operator Equipment Checklist, as the paper card: the equipment with its
 * hours, the numbered columns against the 21 lines, the comments, and the
 * legend at the foot, word for word.
 */
export function ChecklistCardSheet({ card, name, clock, current, hrefFor }: {
  card: DailyCard;
  name: string;
  /** "Total daily hours worked", from the time clock. Left out when the company does not keep time. */
  clock?: DayClock;
  /** The checklist this card was opened for. */
  current?: string;
  hrefFor?: (inspectionId: string) => string;
}) {
  const slots: (CardColumn | undefined)[] = Array.from({ length: CARD_COLUMNS }, (_, i) => card.columns[i]);
  // The lines read the same on every machine.
  const lines = checklistFor('loader').items;
  return (
    <Sheet title="Operator equipment checklist" label={`Operator equipment checklist, ${name}, ${fmtDate(card.day)}`}>
      <Lines>
        <Line label="Employee:" value={name} />
        <Line label="Date:" value={fmtDate(card.day)} />
      </Lines>
      <div className="sheet-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="n" scope="col">#</th>
              <th className="left" scope="col">Equipment</th>
              <th className="hrs" scope="col">Equp. hrs st</th>
              <th className="hrs" scope="col">Equp. hrs. end</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((column, i) => (
              <tr key={i} className={column && column.inspection.id === current ? 'current' : undefined}>
                <td className="n">{i + 1}</td>
                <td>
                  {column ? (
                    <span className="unitcell">
                      {hrefFor ? <A href={hrefFor(column.inspection.id)}>{column.unit?.unit ?? 'Removed'}</A> : <strong className="cond">{column.unit?.unit ?? 'Removed'}</strong>}
                      <span className="muted small">{column.unit ? `${column.unit.make} ${column.unit.model}` : 'Removed from fleet'}</span>
                      {column.inspection.result === 'bad_order' ? <span className="small" style={{ color: 'var(--red)', fontWeight: 700 }}>Bad Order, red tagged</span> : null}
                      {column.inspection.result === 'defect' ? <span className="small" style={{ color: 'var(--amber)', fontWeight: 700 }}>Defect reported</span> : null}
                      {column.inUse ? <span className="small muted">In use</span> : null}
                    </span>
                  ) : null}
                </td>
                <td className="hrs">{column ? fmtMeter(column.hoursStart) : ''}</td>
                <td className="hrs">{column?.hoursEnd != null ? fmtMeter(column.hoursEnd) : ''}</td>
              </tr>
            ))}
            {clock ? (
              <tr className="total">
                <th colSpan={3} scope="row" style={{ textAlign: 'center' }}>
                  {'<>'} Total daily hours worked {'<>'}
                  {clock.running ? <span className="small muted" style={{ display: 'block', textTransform: 'none', fontFamily: 'var(--text)', fontWeight: 500, letterSpacing: 0 }}>So far. Still on the clock.</span> : null}
                  {clock.noClockOut ? (
                    <span className="small" style={{ display: 'block', color: 'var(--red)', textTransform: 'none', fontFamily: 'var(--text)', fontWeight: 600, letterSpacing: 0 }}>
                      No clock-out that day. Not counted until a supervisor sets the time.
                    </span>
                  ) : null}
                </th>
                <td className="hrs" style={{ fontWeight: 700, fontSize: '1.375rem' }}>{clock.paid > 0 ? fmtHrs(clock.paid) : ''}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <table className="grid">
          <thead>
            <tr>
              {slots.map((_, i) => (
                <th key={i} className="mark" scope="col">{i + 1}</th>
              ))}
              <th className="left" scope="col">Check list items</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                {slots.map((column, i) => {
                  const answer = column && onTheCard(column.inspection) ? column.inspection.answers.find((a) => a.itemId === line.id)?.answer : undefined;
                  const gallons = line.id === FUEL_LINE ? column?.fuelGal : undefined;
                  return (
                    <td key={i} className="mark" aria-label={column && answer ? `${column.unit?.unit ?? `Unit ${i + 1}`}, ${line.label}: ${SAY[answer]}` : undefined}>
                      <Mark answer={answer} />
                      {gallons != null ? <span className="gal">{gal(gallons)}</span> : null}
                    </td>
                  );
                })}
                <th scope="row">{line.id === FUEL_LINE ? 'Fuel   gallons added:' : line.label}</th>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="comments">
        <span className="printed">Comments:</span>
        {card.comments.length === 0 ? <span>&nbsp;</span> : null}
        {card.comments.map((comment, i) => (
          <p key={i} className="comment">
            <span className="comment-n">{comment.n}</span>
            <span className="written">{comment.text}</span>
          </p>
        ))}
      </div>
      <div className="legend">
        {(['ok', 'bo', 'na'] as Answer[]).map((answer) => (
          <p key={answer}><b>{ANSWER_MARK[answer]}</b> = {ANSWER_LEGEND[answer]}</p>
        ))}
      </div>
    </Sheet>
  );
}

// ---- The Pre Shift Exam ----------------------------------------------------------------------

/**
 * A pre shift exam as the paper: the area's lines against guarding, electrical
 * and safe access, or against the one OK/BO column of a sheet that has a single
 * column, then the conditions page. What the paper puts under "Notes / Date
 * fixed" is written under the line it belongs to.
 */
export function ExamPaper({ exam, examiner, nameOf, mrfNumber, mrfHref }: {
  exam: AreaExam;
  examiner: string;
  nameOf: (id: string) => string;
  mrfNumber: (mrfId: string) => number | undefined;
  mrfHref: (mrfId: string) => string;
}) {
  const conditionOf = new Map(AREA_CONDITIONS.map((c) => [c.id, c]));
  const span = exam.single ? 2 : 4;

  const notes = (line: ExamRow | ExamCondition, cols: number, key: string) => {
    const number = line.mrfId ? mrfNumber(line.mrfId) : undefined;
    if (!line.note && !line.fixed && number == null && !line.danger) return null;
    return (
      <tr className="notes" key={key}>
        <td colSpan={cols}>
          <span className="notes-head">Notes / Date fixed</span>
          {line.note ? <p className={`note-text ${line.fixed ? '' : 'note-open'}`}>{line.note}</p> : null}
          {line.danger ? <p className="note-text note-open" style={{ fontWeight: 700 }}>Marked as a danger. People kept out.</p> : null}
          {number != null && line.mrfId ? <p className="small"><A href={mrfHref(line.mrfId)}>Maintenance request #{number}</A></p> : null}
          {line.fixed ? (
            <p className="note-text note-fixed">
              Fixed {fmtDateTime(line.fixed.at)} by {nameOf(line.fixed.by)}{line.fixed.note ? `: ${line.fixed.note}` : ''}
            </p>
          ) : (line.note || line.danger) ? (
            <p className="small muted">No date fixed yet. It stays open until one is recorded.</p>
          ) : null}
        </td>
      </tr>
    );
  };

  return (
    <div className="desk">
      <Sheet title={`${exam.area} pre shift exam`}>
        <Lines>
          <Line label="Employee:" value={examiner} wide />
          <Line label="Date+shift:" value={`${fmtDate(exam.submittedAt)}, ${shiftLabel(exam.shift)}`} wide />
        </Lines>
        <div className="sheet-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="left" scope="col">{exam.area} areas:</th>
                {exam.single ? (
                  <th className="mark-wide" scope="col">OK/BO</th>
                ) : (
                  EXAM_COLUMNS.map((c) => <th key={c.id} className="mark" scope="col">{c.label}</th>)
                )}
              </tr>
            </thead>
            <tbody>
              {exam.rows.length === 0 ? (
                <tr><td colSpan={span} className="left muted">No lines on this area’s sheet.</td></tr>
              ) : null}
              {exam.rows.flatMap((row) => [
                <tr key={row.id}>
                  <th scope="row">
                    {row.other ? <span className="other">Other (specify): </span> : null}
                    {row.label}
                  </th>
                  {exam.single ? (
                    <td className="mark-wide"><Mark answer={rowAnswer(row)} /></td>
                  ) : (
                    EXAM_COLUMNS.map((c) => <td key={c.id} className="mark"><Mark answer={row[c.id]} /></td>)
                  )}
                </tr>,
                notes(row, span, `${row.id}-notes`),
              ])}
            </tbody>
          </table>
        </div>
      </Sheet>

      <Sheet title="Conditions" label={`Conditions page, ${exam.area}, ${fmtDate(exam.submittedAt)}`}>
        <div className="sheet-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="left" scope="col"><span className="sr-only">Condition</span></th>
                <th className="mark" scope="col">OK</th>
                <th className="mark" scope="col">Bad order</th>
              </tr>
            </thead>
            <tbody>
              {exam.conditions.flatMap((line) => {
                const condition = conditionOf.get(line.id);
                return [
                  <tr key={line.id}>
                    <th scope="row">
                      {condition?.label ?? line.id}
                      {condition?.detail ? <span className="detail"> ({condition.detail.charAt(0).toLowerCase() + condition.detail.slice(1)})</span> : null}
                    </th>
                    {line.answer === 'na' ? (
                      <td className="mark" colSpan={2}><Mark answer="na" /></td>
                    ) : (
                      <>
                        <td className="mark">{line.answer === 'ok' ? <Mark answer="ok" /> : null}</td>
                        <td className="mark">{line.answer === 'bo' ? <Mark answer="bo" /> : null}</td>
                      </>
                    )}
                  </tr>,
                  notes(line, 3, `${line.id}-notes`),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Sheet>
    </div>
  );
}

// ---- The Maintenance Request -------------------------------------------------------------------

export function MrfPaper({ mrf, unit, nameOf }: { mrf: Mrf; unit?: Equipment; nameOf: (id?: string) => string }) {
  const where = [unit ? `${unit.unit} ${unit.make} ${unit.model}` : mrf.equipmentId ? 'A unit since removed from the fleet' : '', mrf.location ?? ''].filter(Boolean).join(', ');
  return (
    <Sheet title="Maintenance request" corner={`No. ${mrf.number}`}>
      <Lines>
        <Line label="By" value={nameOf(mrf.requestedBy)} />
        <Line label="Date" value={fmtDateTime(mrf.createdAt)} />
        <Line label="Location" value={where} wide />
        <Line label="Problem" value={mrf.description} wide tall />
        <Line label="Assigned to" value={nameOf(mrf.assignedTo)} wide />
        <Line label="Date completed" value={mrf.completedAt ? fmtDateTime(mrf.completedAt) : ''} />
        <Line label="Time spent" value={mrf.timeSpent != null ? `${fmtHrs(mrf.timeSpent)} hrs` : ''} />
        <Line label="Completed by" value={nameOf(mrf.completedBy)} wide />
        <Line label="Remarks" value={mrf.remarks} wide tall />
      </Lines>
    </Sheet>
  );
}
