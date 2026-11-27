import React from 'react';
import { Linking, Platform, View } from 'react-native';

import { BellRing } from '../../components/icons';
import { Button, Notice } from '../../components/ui';
import { APP_NAME } from '../../config';
import { LUNCH_OVER_CHANNEL } from '../../services/notificationChannels';
import type { LunchNotice } from '../../services/notifications';
import { fmtTime } from '../../util/format';

/**
 * At lunch, when the phone will not show the notice that lunch is over: notifications are off for the app, or, on
 * Android, the Lunch is over kind alone is turned off in the phone's settings. Lunch still ends by itself.
 *
 * On Android a button opens the phone's settings for the app: after a second no the phone never asks again, so that
 * is the only way back. The Clock screen reads what the phone allows again when the app comes back to the front, so
 * the warning goes once the notice is on.
 */
export function NoticeOff({ kind, endsAt }: { kind: Exclude<LunchNotice, 'on'>; endsAt: number }) {
  const at = fmtTime(endsAt);
  return (
    <Notice
      tone="warn"
      icon={BellRing}
      title={kind === 'off' ? 'Notifications are off for this app' : `${LUNCH_OVER_CHANNEL.name} notifications are turned off`}
      body={
        kind === 'off'
          ? `Lunch still ends by itself at ${at}, but the app cannot tell you when it does. Turn notifications on in your phone settings.`
          : `Lunch still ends by itself at ${at}, but the phone will not show the notice. In your phone's notification settings for ${APP_NAME}, turn on the one called ${LUNCH_OVER_CHANNEL.name}.`
      }
    >
      {Platform.OS === 'android' ? <OpenSettings /> : null}
    </Notice>
  );
}

function OpenSettings() {
  const open = async () => {
    try {
      await Linking.openSettings();
    } catch {
      // The words above still say where to go.
    }
  };
  return (
    <View style={{ marginTop: 10 }}>
      <Button testID="open-notice-settings" label="Open phone settings" kind="outline" size="lg" onPress={open} />
    </View>
  );
}
