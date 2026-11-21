import { LocateFixed, MapPin, Minus, Plus } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SiteMap } from '../../components/SiteMap';
import { Button, Divider, IconButton, Notice, Page, Panel, Txt } from '../../components/ui';
import { APP_NAME, DEMO_MODE } from '../../config';
import { checkFix, circleAcres, MAX_ACCURACY_M, type FixCheck, type RawFix } from '../../domain/geofence';
import { MAX_RADIUS_M, MIN_RADIUS_M, townGap } from '../../domain/site';
import type { NoLocation } from '../../domain/types';
import type { ScreenProps } from '../../navigation/types';
import { locate } from '../../services/location';
import { useMe, useStore, useSupervisorHere } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDistance } from '../../util/format';

const commas = (n: number) => Math.round(n).toLocaleString('en-US');

/** Why the phone gave no position, and what to do about it. Putting the pin needs a precise one. */
function noPosition(reason: NoLocation, forPin: boolean): string {
  switch (reason) {
    case 'off':
      // Off for the app, or for the whole phone: either way it is turned on in the phone's settings.
      return `Location is off on this phone or for ${APP_NAME}. Turn it on in your phone settings.`;
    case 'approximate':
      return forPin
        ? `Your phone shares only an approximate location with ${APP_NAME}. Putting the pin needs your precise location: turn on Precise Location for ${APP_NAME} in your phone settings.`
        : `Your phone shares only an approximate location with ${APP_NAME}, so it cannot place you against the boundary. To check, turn on Precise Location for ${APP_NAME} in your phone settings.`;
    case 'no_fix':
      return 'The phone could not get a position. Step into the open and try again.';
  }
}

export function SiteScreen({ navigation }: ScreenProps<'Site'>) {
  const me = useMe();
  const settings = useStore((s) => s.settings);
  const { setRadius, setSitePin, showToast } = useStore.getState();
  const site = settings.site;
  const supervisor = useSupervisorHere();

  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState<RawFix | null>(null);
  const [check, setCheck] = useState<FixCheck | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const away = site ? townGap(site) : undefined;

  /** Move the pin to where the supervisor stands, if the phone can place them well enough. */
  const pinHere = async () => {
    setBusy(true);
    setFailed(null);
    const result = await locate(site, settings.demoLocation);
    setBusy(false);
    if (!result.ok) {
      setFailed(noPosition(result.reason, true));
      return;
    }
    if (result.fix.mocked) {
      setFailed('The phone reported a simulated location. Turn off any mock-location app and try again.');
      return;
    }
    if (result.fix.accuracyM != null && result.fix.accuracyM > MAX_ACCURACY_M) {
      setFailed(`Your phone can only place you to within ${fmtDistance(result.fix.accuracyM)}. Step into the open, give it a few seconds and try again.`);
      return;
    }
    const saved = setSitePin({ lat: result.fix.lat, lng: result.fix.lng });
    if (!saved.ok) {
      setFailed(saved.error);
      return;
    }
    setFix(null);
    setCheck(null);
    showToast('The pin is where you are standing.');
  };

  if (!site) {
    return (
      <Page testID="site-screen" title="Mine boundary" onBack={navigation.goBack}>
        <Notice
          tone="warn"
          title="The mine boundary is not set yet"
          body={
            supervisor
              ? 'No one can clock in until it is. Stand on the mine, near the middle of where the crew works, and put the pin there. The circle starts 1 km out and can be sized after.'
              : 'No one can clock in until a supervisor sets it. Ask a supervisor to set the pin on the mine.'
          }
        />
        {failed ? <Notice tone="warn" title="No position" body={failed} /> : null}
        {supervisor ? <Button testID="site-pin-here" label="Put the pin where I am" icon={MapPin} kind="ink" loading={busy} onPress={pinHere} /> : null}
      </Page>
    );
  }

  const find = async () => {
    setBusy(true);
    setFailed(null);
    const result = await locate(site, settings.demoLocation);
    setBusy(false);
    if (!result.ok) {
      setFix(null);
      setCheck(null);
      setFailed(noPosition(result.reason, false));
      return;
    }
    setFix(result.fix);
    setCheck(checkFix(site, result.fix));
  };

  return (
    <Page testID="site-screen" title="Mine boundary" sub={site.name} onBack={navigation.goBack}>
      <SiteMap site={site} you={fix ?? undefined} youInside={check?.verdict === 'inside'} />

      {check ? (
        <Notice
          tone={check.verdict === 'inside' ? 'ok' : 'bo'}
          title={
            check.verdict === 'inside'
              ? `You are at the mine, ${fmtDistance(Math.max(0, check.marginM))} inside the boundary`
              : check.verdict === 'outside'
                ? `You are ${fmtDistance(-check.marginM)} outside the boundary`
                : check.verdict === 'weak_gps'
                  ? 'The GPS signal is too weak to place you'
                  : 'The phone reported a simulated location'
          }
          body={`${fmtDistance(check.distanceM)} from the mine pin${DEMO_MODE && settings.demoLocation !== 'gps' ? '. This is the demo GPS setting, not your real position.' : fix?.accuracyM ? `, accurate to about ${fmtDistance(fix.accuracyM)}.` : '.'}`}
        />
      ) : null}
      {failed ? <Notice tone="warn" title="No position" body={failed} /> : null}

      {/* A supervisor checks the boundary against where they stand. The crew's location is read only when they punch. */}
      {supervisor ? <Button testID="check-location" label="Check where I am" icon={LocateFixed} kind="ink" loading={busy} onPress={find} /> : null}

      <Panel title="The clock-in boundary" flush>
        <View style={styles.fact}>
          <Txt v="strong">{fmtDistance(site.radiusM)} around the mine pin</Txt>
          <Txt v="body" c={color.inkSoft}>
            About {commas(circleAcres(site.radiusM))} acres. A clock-in made with a location has to be inside it.
          </Txt>
        </View>
        {away && away.gapM > 0 ? (
          <>
            <Divider inset={space.lg} />
            <View style={styles.fact} testID="site-town">
              <Txt v="strong">{away.name} is outside it</Txt>
              <Txt v="body" c={color.inkSoft}>
                {away.name} is {fmtDistance(away.distanceM)} from the pin, {fmtDistance(away.gapM)} beyond the boundary. A clock-in made from there with a location is turned down.
              </Txt>
            </View>
          </>
        ) : null}
        <Divider inset={space.lg} />
        <View style={styles.fact}>
          <Txt v="strong">Your location is read only when you punch</Txt>
          <Txt v="body" c={color.inkSoft}>
            The app never follows you in the background. With location off, only an approximate location, or no position found, a clock-in still goes through, marked for a supervisor to check. Clocking out and starting lunch are never blocked: the location is noted, and an off-site clock-out is flagged for review. Lunch ends by itself after 30 minutes, so no location is read then.
          </Txt>
        </View>
      </Panel>

      {supervisor ? (
        <Panel title="Adjust the boundary">
          <View style={styles.stepper}>
            <IconButton testID="radius-minus" icon={Minus} label="Smaller boundary" bg={color.grayTint} onPress={() => { const done = setRadius(site.radiusM - 50); if (!done.ok) showToast(done.error, 'bo'); }} />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Txt v="num" testID="radius-value">{commas(site.radiusM)} m</Txt>
              <Txt v="small" c={color.silica}>{fmtDistance(site.radiusM)} radius, {commas(circleAcres(site.radiusM))} acres</Txt>
            </View>
            <IconButton testID="radius-plus" icon={Plus} label="Larger boundary" bg={color.grayTint} onPress={() => { const done = setRadius(site.radiusM + 50); if (!done.ok) showToast(done.error, 'bo'); }} />
          </View>
          <Txt v="small" c={color.silica} style={{ marginTop: space.md }}>
            Between {MIN_RADIUS_M} and {commas(MAX_RADIUS_M)} m, in steps of 50 m.
            {away ? ` Past about ${commas(Math.floor((away.distanceM - 800) / 50) * 50)} m the circle starts to reach ${away.name}.` : ''}
          </Txt>
          <View style={{ marginTop: space.lg }}>
            <Button testID="site-pin-here" label="Put the pin where I am" icon={MapPin} kind="outline" loading={busy} onPress={pinHere} />
          </View>
        </Panel>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  fact: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
