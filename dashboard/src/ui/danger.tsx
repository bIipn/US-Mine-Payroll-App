import type { Finding } from '@app/domain/areaExam';
import { fmtDateTime } from '@app/util/format';

import { A } from './kit';

/** Where on the sheet a condition is, as words after its line: "(guarding)", "(conditions page)". */
export const whereWords = (where: string) => (where === 'Conditions' ? 'conditions page' : where.toLowerCase());

/**
 * A danger from a pre shift exam, shown as a danger: a solid band, ahead of
 * anything else open on the page, naming the area, the line and the column of
 * each one, with what was wrong. People stay out until its date fixed is recorded.
 */
export function DangerBand({ dangers, nameOf, linked = true, id = 'danger-title' }: {
  dangers: Finding[];
  nameOf: (id?: string) => string;
  /** Link each one to its exam; off on the exam itself. */
  linked?: boolean;
  id?: string;
}) {
  if (dangers.length === 0) return null;
  return (
    <section className="danger-band" aria-labelledby={id} role="region">
      <h2 id={id}>Danger, keep out</h2>
      <ul>
        {dangers.map((f) => {
          const line = `${f.area}: ${f.label} (${whereWords(f.where)})`;
          return (
            <li key={`${f.examId}:${f.key}`}>
              {linked ? <A href={`/exams/${encodeURIComponent(f.examId)}`}>{line}</A> : <strong>{line}</strong>}
              {f.note ? <span>{f.note}</span> : null}
              <span className="small">Found {fmtDateTime(f.foundAt)} by {nameOf(f.employeeId)}. People stay out until its date fixed is recorded.</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
