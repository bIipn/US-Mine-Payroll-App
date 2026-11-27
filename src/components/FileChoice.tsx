import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { ChooseFileWay, FileAsk, FileChoice } from '../services/saveFile';
import { color } from '../theme/theme';
import { Eye, FolderDown, Share2, TriangleAlert } from './icons';
import { Button, Notice, Sheet, Txt } from './ui';

/**
 * Which way an export goes, asked on Android once the file is made. Android's share sheet only sends a file
 * to another app (an iPhone's also saves it to Files, prints it and shows it), so `saveFile` asks here first:
 * Open on this phone, offered only when an app on the phone opens the type; Save to phone, in a folder the
 * person picks or makes; or Send to another app, the share sheet. Closing the sheet, or leaving the screen
 * with it up, sends the file nowhere. An iPhone and a browser never ask.
 *
 * Pass `choose` to the export, and put `sheet` on the screen.
 */
export function useFileChoice(): { choose: ChooseFileWay; sheet: React.ReactElement } {
  const [ask, setAsk] = useState<FileAsk | null>(null);
  // What the sheet showed last, so it does not go blank as it slides away.
  const last = useRef<FileAsk | null>(null);
  const waiting = useRef<((pick: FileChoice | null) => void) | null>(null);

  const answer = useCallback((pick: FileChoice | null) => {
    setAsk(null);
    const go = waiting.current;
    waiting.current = null;
    go?.(pick);
  }, []);
  const choose = useCallback<ChooseFileWay>(
    (next) =>
      new Promise<FileChoice | null>((resolve) => {
        // A second file made while the first is still asked about: the first goes nowhere.
        waiting.current?.(null);
        waiting.current = resolve;
        last.current = next;
        setAsk(next);
      }),
    [],
  );
  useEffect(() => () => waiting.current?.(null), []);

  const shown = ask ?? last.current;
  const sheet = (
    <Sheet testID="file-choice" visible={ask != null} onClose={() => answer(null)} title="Your file is ready">
      <Txt v="body">{shown?.name}</Txt>
      {shown?.note ? <Notice tone="warn" icon={TriangleAlert} title={shown.note} /> : null}
      {shown?.canOpen ? (
        <Button testID="file-open" label="Open on this phone" icon={Eye} kind="ink" onPress={() => answer('open')} />
      ) : null}
      <Button
        testID="file-save"
        label="Save to phone"
        sub="Pick a folder, or make a new one"
        icon={FolderDown}
        kind={shown?.canOpen ? 'outline' : 'ink'}
        onPress={() => answer('save')}
      />
      <Button testID="file-share" label="Send to another app" icon={Share2} kind="outline" onPress={() => answer('share')} />
      <Txt v="small" c={color.inkSoft}>
        Android may not let you pick the Download folder itself. If it says so, make a folder inside it and pick that.
      </Txt>
    </Sheet>
  );
  return { choose, sheet };
}
