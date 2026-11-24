import React from 'react';
import { Image, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import type { CompanyLogo } from '../domain/company';
import type { AuthProvider } from '../domain/types';
import { color } from '../theme/theme';

/**
 * The traced artwork of US Mine Corporation's logo, or null in a build that
 * leaves it out. A store build sets EXPO_PUBLIC_LOGO_ART=0 (eas.json): the
 * public app carries no customer's trademark. The condition is written with
 * the setting itself, so the bundler reads it as a constant and drops the
 * artwork from such a build. Without it, a company whose logo is the traced
 * art shows no logo, and its screens keep their plain colour.
 */
const LOGO_ART: typeof import('./logoArt').LOGO_ART | null =
  process.env.EXPO_PUBLIC_LOGO_ART !== '0' ? require('./logoArt').LOGO_ART : null;

/** Whether this build has the traced artwork to draw a company's built-in logo with. */
export const HAS_LOGO_ART = LOGO_ART != null;

/**
 * US Mine Corporation's logo: the navy lettering over the gold stepped rule.
 * It is drawn from the traced artwork in logoArt.ts at whatever width is asked
 * for, always in its own proportions and its own colours.
 */
export const Logo = React.memo(function Logo({ width }: { width: number }) {
  if (!LOGO_ART) return null;
  const height = (width * LOGO_ART.height) / LOGO_ART.width;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${LOGO_ART.width} ${LOGO_ART.height}`}>
      <Path d={LOGO_ART.lettering} fill={LOGO_ART.navy} fillRule="evenodd" />
      <Path d={LOGO_ART.rule} fill="none" stroke={LOGO_ART.gold} strokeWidth={LOGO_ART.ruleWidth} />
    </Svg>
  );
});

/**
 * The logo on the white plate it is made for, so it reads the same on any of
 * the app's coloured backgrounds. The stepped rule runs to both edges of the
 * plate, the way it runs to the edges of the company's own artwork.
 */
export function LogoPlate({ width, radius = 8 }: { width: number; radius?: number }) {
  if (!LOGO_ART) return null;
  return (
    <View
      testID="brand-logo"
      accessibilityRole="image"
      accessibilityLabel="US Mine Corporation"
      style={{ alignSelf: 'flex-start', width, backgroundColor: color.white, borderRadius: radius, overflow: 'hidden' }}
    >
      <Logo width={width} />
    </View>
  );
}

/**
 * The company's own logo on a white plate, where the app shows it: the top of
 * the clock screen and the sign-in screen. A company with no logo shows
 * nothing here, and the screen keeps its plain colour.
 */
export function CompanyLogoPlate({ logo, name, width, radius = 8 }: {
  logo?: CompanyLogo;
  name: string;
  width: number;
  radius?: number;
}) {
  if (!logo) return null;
  if ('art' in logo) return LOGO_ART ? <LogoPlate width={width} radius={radius} /> : null;
  return (
    <View
      testID="brand-logo"
      accessibilityRole="image"
      accessibilityLabel={name || 'Company logo'}
      style={{ alignSelf: 'flex-start', width, backgroundColor: color.white, borderRadius: radius, overflow: 'hidden', padding: width * 0.04 }}
    >
      <Image source={{ uri: logo.uri }} resizeMode="contain" style={{ width: width * 0.92, height: width * 0.3 }} />
    </View>
  );
}

/** The MineMuster lockup, made from its renders by scripts/make-brand-assets.py. Width over height. */
const MINEMUSTER_LOGO = require('../../assets/brand/minemuster-logo.webp');
const MINEMUSTER_RATIO = 840 / 390;

/**
 * MineMuster's own logo: the silver MM over MINE MUSTER. Its black is
 * transparent and its glow fades out, so it sits on any dark colour; it is
 * made for the dark sign-in screen and never goes on a light one. Shown where
 * a company has no logo of its own.
 */
export function MineMusterLogo({ width }: { width: number }) {
  return (
    <Image
      testID="minemuster-logo"
      accessibilityRole="image"
      accessibilityLabel="MineMuster"
      source={MINEMUSTER_LOGO}
      resizeMode="contain"
      style={{ width, height: width / MINEMUSTER_RATIO }}
    />
  );
}

/** Sign-in provider marks, drawn to each provider's published button guidelines. */
export function ProviderMark({ provider, size = 22 }: { provider: AuthProvider; size?: number }) {
  if (provider === 'apple') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          fill={color.white}
          d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
        />
      </Svg>
    );
  }
  if (provider === 'google') {
    return (
      <Svg width={size} height={size} viewBox="0 0 48 48">
        <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 21 21">
      <Rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <Rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <Rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <Rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </Svg>
  );
}
