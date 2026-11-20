import React from 'react';

import { WEB_PAGES } from '../config';
import { haptic } from '../services/haptics';
import { openWebPage } from '../services/links';
import { useStore } from '../store/useStore';
import { color, space } from '../theme/theme';
import { CircleHelp, ExternalLink, ShieldCheck } from './icons';
import { Divider, Panel, Row } from './ui';

/**
 * MineMuster's privacy policy and help page, opened in the phone's browser.
 * On the sign-in screen, More and Company account: the stores want the
 * privacy policy easy to find inside the app, before and after signing in.
 */
export function WebPageLinks({ testID = 'web-pages' }: { testID?: string }) {
  const open = async (url: string) => {
    haptic.tap();
    if (!(await openWebPage(url))) {
      useStore.getState().showToast(`This phone could not open the page. In a browser, go to ${url.replace('https://', '')}.`, 'bo');
    }
  };
  const leaving = <ExternalLink color={color.silicaLight} size={20} />;
  return (
    <Panel title="Help and privacy" flush>
      <Row
        testID={`${testID}-privacy`}
        left={<ShieldCheck color={color.ink} size={24} />}
        title="Privacy policy"
        sub="What MineMuster keeps and who sees it. Opens minemuster.com."
        right={leaving}
        onPress={() => void open(WEB_PAGES.privacy)}
      />
      <Divider inset={space.lg} />
      <Row
        testID={`${testID}-help`}
        left={<CircleHelp color={color.ink} size={24} />}
        title="Help and contact"
        sub="Ask a question or report a problem. Opens minemuster.com."
        right={leaving}
        onPress={() => void open(WEB_PAGES.help)}
      />
    </Panel>
  );
}
