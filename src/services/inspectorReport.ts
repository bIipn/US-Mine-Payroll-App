import { examCounts, examFindings, examResult, shiftLabel } from '../domain/areaExam';
import { checklistFor, findItem, isHazard, onTheCard } from '../domain/templates';
import type { Employee, Inspection, Mrf } from '../domain/types';
import { addDays, DAY, fmtDayShort, fmtTime, fmtWeekday, ymd } from '../util/format';
import { buildPdf, type PdfSection } from './pdf';
import type { ReportData } from './reports';

/**
 * The records an MSHA inspector asks to see, as one PDF a supervisor can hand
 * over or send from the phone: equipment defects (30 CFR 56.14100(d)), the
 * pre-use inspections of mobile equipment (56.14100(a)), and the workplace
 * examinations with the conditions found and the date each was corrected
 * (56.18002). Every record shows when it was signed, and the document says
 * when it was made and in which time zone.
 *
 * It is made from the same records as the Excel safety log, so the two agree.
 */

export interface PdfReport {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

const nameOf = (e?: Employee) => (e ? `${e.lastName}, ${e.firstName}` : 'Unknown');
/** "Nov 13, 2026" */
const day = (ms: number) => `${fmtDayShort(ms)}, ${new Date(ms).getFullYear()}`;
/** "Nov 13, 2026, 6:42 AM" */
const stamp = (ms: number) => `${day(ms)}, ${fmtTime(ms)}`;

/** "UTC-08:00", for the local time on this phone at that moment. */
function utcOffset(ms: number): string {
  const offset = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(offset);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  // A plain hyphen: the standard PDF fonts have no minus sign.
  return `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "Fri, Nov 13, 2026, 10:42:00 AM (UTC-08:00)" */
function generatedAt(ms: number): string {
  const d = new Date(ms);
  const seconds = d.getSeconds() < 10 ? `0${d.getSeconds()}` : `${d.getSeconds()}`;
  const clock = fmtTime(ms).replace(/ (AM|PM)$/, `:${seconds} $1`);
  return `${fmtWeekday(ms)}, ${day(ms)}, ${clock} (${utcOffset(ms)})`;
}

/** "Sample Mining Co." -> "Sample-Mining-Co-", for a file name. */
const filePrefix = (name: string) => {
  const cleaned = name.replace(/[.']/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-` : '';
};

export function inspectorReport(data: ReportData, from: number, to: number, now: number): PdfReport {
  const company = data.settings?.company;
  const employeeOf = new Map(data.employees.map((e) => [e.id, e]));
  const unitOf = new Map(data.equipment.map((e) => [e.id, e]));
  const mrfOf = new Map(data.mrfs.map((m) => [m.id, m]));
  const within = (ms: number) => ms >= from && ms < to;
  const lastDay = to - DAY;
  const corrected = (m?: Mrf) => (m?.status === 'completed' && m.completedAt != null ? m : undefined);

  // ---- Equipment defects: each Bad Order on a checklist in the period, and any older one not yet corrected.
  const defectRows = data.inspections
    .filter((i) => i.submittedAt < to)
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .flatMap((i: Inspection) => {
      const mrf = i.mrfId ? mrfOf.get(i.mrfId) : undefined;
      const done = corrected(mrf);
      if (!within(i.submittedAt) && done) return [];
      const unit = unitOf.get(i.equipmentId);
      const template = checklistFor(unit?.category ?? 'loader');
      const earlier = !onTheCard(i);
      return i.answers
        .filter((a) => a.answer === 'bo')
        .map((a) => {
          const item = earlier ? undefined : findItem(template, a.itemId);
          const hazard = earlier ? i.result === 'bad_order' : isHazard(template, a);
          return [
            stamp(i.submittedAt),
            unit ? `${unit.unit}\n${unit.make} ${unit.model}` : 'Removed from fleet',
            nameOf(employeeOf.get(i.employeeId)),
            earlier ? 'Earlier checklist' : (item?.label ?? a.itemId),
            a.note ?? '',
            hazard ? 'Yes, taken out of service' : 'No',
            mrf ? `#${mrf.number}` : 'None yet',
            done ? `${stamp(done.completedAt!)}\n${nameOf(employeeOf.get(done.completedBy ?? ''))}` : 'Not yet',
          ];
        });
    });

  // ---- Pre-use inspections signed in the period.
  const inspectionRows = data.inspections
    .filter((i) => within(i.submittedAt))
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .map((i) => {
      const unit = unitOf.get(i.equipmentId);
      const bad = i.answers.filter((a) => a.answer === 'bo').length;
      const mrf = i.mrfId ? mrfOf.get(i.mrfId) : undefined;
      return [
        stamp(i.submittedAt),
        unit ? `${unit.unit}\n${unit.make} ${unit.model}` : 'Removed from fleet',
        nameOf(employeeOf.get(i.employeeId)),
        i.meter.toFixed(1),
        i.result === 'pass' ? 'Passed' : i.result === 'bad_order' ? `Out of service: ${bad} Bad Order${bad === 1 ? '' : 's'}` : `${bad} Bad Order${bad === 1 ? '' : 's'}`,
        mrf ? `#${mrf.number}` : '',
      ];
    });

  // ---- Workplace examinations made in the period.
  const exams = data.exams.filter((x) => within(x.submittedAt)).sort((a, b) => a.submittedAt - b.submittedAt);
  const examRows = exams.map((exam) => {
    const counts = examCounts(exam);
    const found = examFindings(exam);
    const result = examResult(exam);
    return [
      stamp(exam.submittedAt),
      shiftLabel(exam.shift),
      exam.area,
      nameOf(employeeOf.get(exam.employeeId)),
      `${counts.lines}`,
      `${found.length}`,
      result === 'clear' ? 'No conditions found' : result === 'danger' ? 'Imminent danger found' : 'Conditions found',
    ];
  });

  // ---- Conditions found: those found in the period, and any older one not yet corrected.
  const conditionRows = data.exams
    .filter((exam) => exam.submittedAt < to)
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .flatMap((exam) => examFindings(exam).filter((f) => within(f.foundAt) || !f.fixed))
    .map((f) => {
      const mrf = f.mrfId ? mrfOf.get(f.mrfId) : undefined;
      return [
        stamp(f.foundAt),
        f.area,
        nameOf(employeeOf.get(f.employeeId)),
        // Which part of the paper it was on: a column of the area sheet, or the conditions page.
        `${f.label}${f.where ? `\n(${f.where === 'Conditions' ? 'Conditions page' : f.where})` : ''}`,
        f.note ?? '',
        f.danger ? 'Yes' : 'No',
        mrf ? `#${mrf.number}` : '',
        f.fixed ? `${stamp(f.fixed.at)}\n${nameOf(employeeOf.get(f.fixed.by))}${f.fixed.note ? `\n${f.fixed.note}` : ''}` : 'Not yet',
      ];
    });

  const sections: PdfSection[] = [
    {
      title: 'Equipment defects affecting safety',
      note:
        '30 CFR 56.14100(d): defects on self-propelled mobile equipment that affect safety and are not corrected immediately are reported to and recorded by the mine operator, and the record is kept until the defect is corrected. ' +
        'Each Bad Order marked on an operator equipment checklist in the period, and any older one not yet corrected, with the maintenance request it was sent on and when it was corrected.',
      columns: [
        { header: 'Found', width: 1.15 }, { header: 'Unit', width: 1.15 }, { header: 'Found by', width: 1.05 }, { header: 'Line', width: 1.2 },
        { header: 'What was wrong', width: 2 }, { header: 'Unsafe to run', width: 0.95 }, { header: 'Request', width: 0.6 }, { header: 'Corrected', width: 1.35 },
      ],
      rows: defectRows,
      empty: 'No Bad Order was marked on an equipment checklist in this period, and none from before it is waiting to be corrected.',
    },
    {
      title: 'Pre-use equipment inspections',
      note:
        '30 CFR 56.14100(a): self-propelled mobile equipment is inspected by the equipment operator before it is placed in operation on the shift. ' +
        'Each operator equipment checklist signed in the period, with the equipment hours at the check.',
      columns: [
        { header: 'Signed', width: 1.2 }, { header: 'Unit', width: 1.3 }, { header: 'Operator', width: 1.2 }, { header: 'Equipment hours', width: 0.8 },
        { header: 'Result', width: 1.4 }, { header: 'Request', width: 0.6 },
      ],
      rows: inspectionRows,
      empty: 'No equipment checklist was signed in this period.',
    },
    {
      title: 'Workplace examinations',
      note:
        '30 CFR 56.18002(a) and (b): a competent person examines each working place at least once each shift, before miners begin work there, and a record is made before the end of the shift of who examined it, the date, the areas examined and each condition found. ' +
        'Each pre shift exam signed in the period.',
      columns: [
        { header: 'Signed', width: 1.2 }, { header: 'Shift', width: 0.6 }, { header: 'Working place', width: 1.6 }, { header: 'Examined by', width: 1.3 },
        { header: 'Lines checked', width: 0.7 }, { header: 'Conditions found', width: 0.8 }, { header: 'Result', width: 1.2 },
      ],
      rows: examRows,
      empty: 'No pre shift exam was signed in this period.',
    },
    {
      title: 'Conditions found on workplace examinations',
      note:
        '30 CFR 56.18002(b) and (c): each condition that may adversely affect safety or health, and the date it was corrected, added once it is. ' +
        'Each condition found in the period, and any older one not yet corrected. The records are kept for at least one year (56.18002(d)).',
      columns: [
        { header: 'Found', width: 1.15 }, { header: 'Working place', width: 1.15 }, { header: 'Found by', width: 1.05 }, { header: 'Line', width: 1.3 },
        { header: 'What was wrong', width: 2 }, { header: 'Imminent danger', width: 0.75 }, { header: 'Request', width: 0.6 }, { header: 'Corrected', width: 1.4 },
      ],
      rows: conditionRows,
      empty: 'No condition was found on a workplace examination in this period, and none from before it is waiting to be corrected.',
    },
  ];

  const who = company?.name ? `${company.name}${company.place ? `, ${company.place}` : ''}` : 'Mine operator';
  const heading = [
    who,
    ...(company?.mineId ? [`MSHA mine ID ${company.mineId}`] : []),
    `Records from ${day(from)} to ${day(lastDay)}.`,
    `Generated ${generatedAt(now)} from the records kept in MineMuster. Every record shows the date and time it was signed, in this time zone.`,
  ];
  const bytes = buildPdf({
    title: 'Records for an MSHA inspector',
    heading,
    footer: `${company?.name ? `${company.name} records` : 'Records'}, ${day(from)} to ${day(lastDay)}. Generated ${generatedAt(now)}.`,
    sections,
    created: now,
  });
  const pages = Number(String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 4096))).match(/\/Count (\d+)/)?.[1] ?? 1);
  return {
    name: `${filePrefix(company?.name ?? '')}MSHA-Records_${ymd(from)}_to_${ymd(addDays(to, -1))}.pdf`,
    bytes,
    pages,
  };
}
