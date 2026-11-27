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
    <View style={[signInStyles.band, { paddingTop: insets.top + space.xxl }]}>
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

/** The page behind a sign-in screen, the band, and the card its form sits on, over the foot of the band. */
export const signInStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  band: { backgroundColor: color.ink, paddingHorizontal: space.xl, paddingBottom: 64 },
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
