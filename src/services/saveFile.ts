/**
 * Hand a generated file to the user — web build: a normal browser download.
 * The phone builds use saveFile.native.ts, which opens the share sheet.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}
