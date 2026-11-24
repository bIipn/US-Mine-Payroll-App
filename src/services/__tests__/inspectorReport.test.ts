import { SAMPLE_COMPANY } from '../../domain/company';
import { examFindings } from '../../domain/areaExam';
import { buildDemoData } from '../../store/seed';
import { addDays, startOfDay } from '../../util/format';
import { inspectorReport } from '../inspectorReport';

const now = new Date(2026, 10, 13, 10, 42).getTime();
const to = addDays(startOfDay(now), 1);
const from = addDays(to, -30);
const data = { ...buildDemoData(now), settings: { company: SAMPLE_COMPANY, workweekStartsOn: 0 } };

/** Every piece of text drawn on the pages, in order. */
function drawn(bytes: Uint8Array): string {
  const text = String.fromCharCode(...bytes);
  return [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('\n');
}

describe('the records for an MSHA inspector', () => {
  const report = inspectorReport(data, from, to, now);
  const text = drawn(report.bytes);

  it('is a PDF named for the company and the period', () => {
    expect(String.fromCharCode(...report.bytes.slice(0, 8))).toBe('%PDF-1.4');
    expect(report.name).toBe('Sample-Mining-Co-MSHA-Records_2026-10-15_to_2026-11-13.pdf');
    expect(report.pages).toBeGreaterThan(1);
  });

  it('says whose records they are, for what period, and when it was made, with the time zone', () => {
    expect(text).toContain('Records for an MSHA inspector');
    expect(text).toContain('Sample Mining Co.');
    expect(text).toContain('Oct 15, 2026 to Nov 13, 2026');
    expect(text).toMatch(/Generated Fri, Nov 13, 2026, 10:42:00 AM \(UTC[+-]\d\d:\d\d\)/);
  });

  it('holds the four kinds of record, each under the standard it answers to', () => {
    expect(text).toContain('Equipment defects affecting safety');
    expect(text).toContain('30 CFR 56.14100(d)');
    expect(text).toContain('Pre-use equipment inspections');
    expect(text).toContain('30 CFR 56.14100(a)');
    expect(text).toContain('Workplace examinations');
    expect(text).toContain('30 CFR 56.18002');
    expect(text).toContain('Conditions found on workplace examinations');
  });

  it('lists every Bad Order in the period with the unit and who found it', () => {
    const inPeriod = data.inspections.filter((i) => i.submittedAt >= from && i.submittedAt < to && i.answers.some((a) => a.answer === 'bo'));
    expect(inPeriod.length).toBeGreaterThan(0);
    for (const i of inPeriod) {
      const unit = data.equipment.find((e) => e.id === i.equipmentId)!.unit;
      expect(text).toContain(unit);
    }
  });

  it('carries forward an older defect that has not been corrected, and leaves out one that was', () => {
    const old = startOfDay(from) - 3 * 86_400_000;
    const unit = data.equipment[0];
    const open = {
      ...data.inspections[0], id: 'old-open', equipmentId: unit.id, submittedAt: old, mrfId: undefined, result: 'defect' as const,
      answers: [{ itemId: 'walk_tires', answer: 'bo' as const, note: 'Cut in the left rear sidewall' }],
    };
    const closedMrf = { ...data.mrfs[0], id: 'old-mrf', status: 'completed' as const, completedAt: old + 86_400_000, completedBy: data.employees[0].id, remarks: 'Replaced' };
    const closed = { ...open, id: 'old-closed', mrfId: 'old-mrf', answers: [{ itemId: 'walk_tires', answer: 'bo' as const, note: 'Cracked step' }] };
    const withOld = { ...data, inspections: [...data.inspections, open, closed], mrfs: [...data.mrfs, closedMrf] };
    const t = drawn(inspectorReport(withOld, from, to, now).bytes);
    expect(t).toContain('Cut in the left rear sidewall');
    expect(t).not.toContain('Cracked step');
  });

  it('shows when each condition found on an exam was corrected, or that it is still open', () => {
    const findings = data.exams.filter((x) => x.submittedAt >= from && x.submittedAt < to).flatMap(examFindings);
    expect(findings.some((f) => f.fixed)).toBe(true);
    expect(text).toContain('Not yet');
  });

  it('says which part of the paper each condition was on', () => {
    const findings = data.exams.filter((x) => x.submittedAt >= from && x.submittedAt < to).flatMap(examFindings);
    expect(findings.some((f) => f.where === 'Conditions')).toBe(true);
    expect(text).toContain('(Conditions page)');
  });

  it('names the mine by its MSHA mine ID when the company has given one', () => {
    const withId = { ...data, settings: { ...data.settings, company: { ...SAMPLE_COMPANY, mineId: '0400123' } } };
    expect(drawn(inspectorReport(withId, from, to, now).bytes)).toContain('MSHA mine ID 0400123');
    expect(text).not.toContain('MSHA mine ID');
  });
});
