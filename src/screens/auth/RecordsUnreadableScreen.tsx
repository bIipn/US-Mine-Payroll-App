import React, { useState } from 'react';
import { Platform } from 'react-native';

import { RotateCcw, TriangleAlert } from '../../components/icons';
import { Button, Notice, Page, Txt } from '../../components/ui';
import { useStore } from '../../store/useStore';
import { color } from '../../theme/theme';

/** What the screen says on a phone, and in a browser, where there is no app to delete. */
function words(): { title: string; next: string; keep: string } {
  if (Platform.OS === 'web') {
    return {
      title: 'The records in this browser could not be read',
      next: 'Try again first. If they still cannot be read, close this tab and open MineMuster again, then tell your supervisor.',
      keep: 'Do not clear this browser’s cookies or site data: that deletes every record in it.',
    };
  }
  return {
    title: 'The records on this phone could not be read',
    next:
      Platform.OS === 'ios'
        ? 'Swipe MineMuster away to close it, then open it again. If it still says this, ask your supervisor.'
        : 'Tap Try again. If they still cannot be read, close MineMuster and open it again, then tell your supervisor.',
    keep: 'Do not delete the app or clear its storage: that deletes every record on this phone.',
  };
}

/**
 * What the app shows, in place of everything else, when the records saved on this phone could not be read as it
 * opened (`recordsUnreadable`). Opening as a new phone would hide them, and its first save would put an empty
 * phone's in their place; meanwhile nothing is written over them, in any build (recordGuard.ts). Try again reads
 * them again. On the iPhone that seldom finds them: AsyncStorage forgets a value it could not read until the app is
 * opened again and it reads its list of what it keeps from the phone (storage.native.ts), so the screen says to
 * close MineMuster and open it again. In a browser the records are the site's data, so the words are a browser's:
 * there is no app to delete there, and clearing the browser's cookies and site data is what would take them.
 */
export function RecordsUnreadableScreen() {
  const readRecordsAgain = useStore((s) => s.readRecordsAgain);
  const [reading, setReading] = useState(false);
  const said = words();
  const tryAgain = async () => {
    setReading(true);
    try {
      await readRecordsAgain();
    } finally {
      setReading(false);
    }
  };
  return (
    <Page
      title="Records not read"
      footer={<Button label="Try again" icon={RotateCcw} loading={reading} onPress={() => void tryAgain()} testID="read-records-again" />}
    >
      <Notice
        tone="bo"
        icon={TriangleAlert}
        title={said.title}
        body="Nothing has been deleted. MineMuster stays closed until they can be read, so nothing is saved over them."
      />
      <Txt>{said.next}</Txt>
      <Txt v="small" c={color.silica}>
        {said.keep}
      </Txt>
    </Page>
  );
}
