import { useStore } from '../store/useStore';
import { haptic } from './haptics';
import type { Report } from './reports';
import { saveFile } from './saveFile';
import { XLSX_MIME } from './xlsx';

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
