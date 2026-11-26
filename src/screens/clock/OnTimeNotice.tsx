import React, { useRef, useState } from 'react';
import { View } from 'react-native';

import { BellRing } from '../../components/icons';
import { Button, Notice } from '../../components/ui';

/**
 * Shown on the Clock screen, on Android only, while the phone may hold timed notices back to save battery: without
 * the Alarms & reminders permission the notice that lunch is over can arrive minutes late. One button opens that
 * setting; `onAllow` asks the phone, notes its answer and schedules the reminders again.
 */
export function OnTimeNotice({ onAllow }: { onAllow: () => Promise<void> }) {
  const asking = useRef(false);
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    try {
      await onAllow();
    } finally {
      asking.current = false;
      setBusy(false);
    }
  };
  return (
    <View testID="on-time-notice">
      <Notice
        tone="warn"
        icon={BellRing}
        title="The lunch notice can come late on this phone"
        body="Android holds timed notifications back to save battery. Turn on Alarms & reminders for MineMuster so the notice that lunch is over comes right on time."
      >
        <View style={{ marginTop: 10 }}>
          <Button testID="allow-on-time" label="Allow on-time notices" kind="outline" size="lg" loading={busy} onPress={allow} />
        </View>
      </Notice>
    </View>
  );
}
