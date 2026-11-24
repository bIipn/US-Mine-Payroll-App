import { useStore } from '../store/useStore';
import { haptic } from './haptics';
import type { PdfReport } from './inspectorReport';
import type { CsvFile, Report } from './reports';
import { saveFile } from './saveFile';
import { XLSX_MIME } from './xlsx';

export const PDF_MIME = 'application/pdf';

/** Build an Excel report and hand it to the phone's share sheet or the browser's downloads. */
export async function exportReport(build: () => Report): Promise<void> {
  const { showToast } = useStore.getState();
  try {
    const report = build();
    const saved = await saveFile(report.name, report.bytes, XLSX_MIME);
    if (saved) {
      haptic.success();
      showToast(`Excel file ready: ${report.sheets} sheets, ${report.rows} rows`);
    } else {
      haptic.error();
      showToast('The file was built but could not be saved on this device.', 'bo');
    }
  } catch {
    haptic.error();
    showToast('The Excel file could not be built. Try a shorter date range.', 'bo');
  }
}

/** Build a PDF and hand it over the same way: share sheet on a phone, a download in a browser. */
export async function exportPdf(build: () => PdfReport): Promise<void> {
  const { showToast } = useStore.getState();
  try {
    const report = build();
    const saved = await saveFile(report.name, report.bytes, PDF_MIME);
    if (saved) {
      haptic.success();
      showToast(`PDF ready: ${report.pages} ${report.pages === 1 ? 'page' : 'pages'}`);
    } else {
      haptic.error();
      showToast('The file was built but could not be saved on this device.', 'bo');
    }
  } catch {
    haptic.error();
    showToast('The PDF could not be built. Try a shorter date range.', 'bo');
  }
}

/** Build a CSV and hand it over the same way. */
export async function exportCsv(build: () => CsvFile): Promise<void> {
  const { showToast } = useStore.getState();
  try {
    const file = build();
    const saved = await saveFile(file.name, file.bytes, 'text/csv');
    if (saved) {
      haptic.success();
      showToast(file.lines ? `Payroll hours file ready: ${file.lines} ${file.lines === 1 ? 'line' : 'lines'}` : 'Payroll hours file ready. No hours in this period.');
    } else {
      haptic.error();
      showToast('The file was built but could not be saved on this device.', 'bo');
    }
  } catch {
    haptic.error();
    showToast('The payroll hours file could not be built. Try a shorter date range.', 'bo');
  }
}
