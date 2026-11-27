import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { signInWords, type Company } from '../domain/company';
import { color, radius, space } from '../theme/theme';
import { CompanyLogoPlate, HAS_LOGO_ART, MineMusterLogo } from './Brand';
import { ScreenStatusBar } from './ScreenStatusBar';
import { Txt } from './ui';

/**
 * The top of both sign-in screens (a build with no server's, and the company sign-in of one that
 * connects): the dark band the logos are made for, with the company's own logo or MineMuster's, and
 * what the app is for (signInWords). `company` is null until the phone knows the company: then
 * MineMuster's logo, and nothing of time or pay. A company whose logo is the traced art shows
 * MineMuster's in a build that leaves the art out, as one with no logo does. The band is under the status
 * bar, so its icons are white while the sign-in screen is in front; a screen opened over it draws its own.
 */
export function SignInHeader({ company }: { company: Company | null }) {
  const insets = useSafeAreaInsets();
  const words = signInWords(company);
  const logo = company?.logo && (!('art' in company.logo) || HAS_LOGO_ART) ? company.logo : null;
  return (
    <View testID="sign-in-band" style={[signInStyles.band, { paddingTop: insets.top + space.xxl }]}>
      <ScreenStatusBar style="light" />
      {company && logo ? <CompanyLogoPlate logo={logo} name={company.name} width={264} radius={10} /> : <MineMusterLogo width={280} />}
      <Txt v="h1" c={color.white} style={{ marginTop: space.xl }}>
        {words.tagline}
      </Txt>
      <Txt v="body" c={color.onDarkMuted} style={{ marginTop: space.sm }}>
        {words.line}
      </Txt>
    </View>
  );
}

/**
 * What stays under the status bar while a sign-in screen's form scrolls: the band is the top of the form, and goes
 * up with it when the form is scrolled or the keyboard pushes it up, but its white status bar icons stay. A strip of
 * the band's own colour, as tall as the status bar, keeps them on dark. Drawn over the form, outside it, so it never
 * moves: at rest it lies on the band's own top, so the screen looks as it would without it. It takes no taps. Where
 * nothing is over the top of the screen (a browser, as a rule) it is not drawn.
 */
export function SignInStatusStrip() {
  const { top } = useSafeAreaInsets();
  if (top <= 0) return null;
  return <View testID="sign-in-status-strip" pointerEvents="none" style={[signInStyles.strip, { height: top }]} />;
}

/** The colour of the band, and of the strip that stands in for its top under the status bar. */
const BAND = color.ink;

/** The page behind a sign-in screen, the band, and the card its form sits on, over the foot of the band. */
export const signInStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  band: { backgroundColor: BAND, paddingHorizontal: space.xl, paddingBottom: 64 },
  strip: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: BAND },
  card: {
    marginTop: -40,
    marginHorizontal: space.lg,
    padding: space.xl,
    gap: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.rule,
  },
});
