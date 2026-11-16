import { LocateFixed, MapPin, Minus, Plus } from '../../components/icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SiteMap } from '../../components/SiteMap';
import { Button, Divider, IconButton, Notice, Page, Panel, Txt } from '../../components/ui';
import { checkFix, circleAcres, MAX_ACCURACY_M, type FixCheck, type RawFix } from '../../domain/geofence';
import { MAX_RADIUS_M, MIN_RADIUS_M, townGap } from '../../domain/site';
import type { ScreenProps } from '../../navigation/types';
import { locate } from '../../services/location';
import { useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDistance } from '../../util/format';

const commas = (n: number) => Math.round(n).toLocaleString('en-US');

export function SiteScreen({ navigation }: ScreenProps<'Site'>) {
  const me = useMe();
  const settings = useStore((s) => s.settings);
  const { setRadius, setSitePin, showToast } = useStore.getState();
  const site = settings.site;
  const supervisor = me?.role === 'supervisor';

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
      setFailed(result.reason === 'denied' ? 'Location is turned off for this app. Turn it on in your phone settings.' : 'The phone could not get a position. Step into the open and try again.');
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
      setFailed(result.reason === 'denied' ? 'Location is turned off for this app. Turn it on in your phone settings.' : 'The phone could not get a position. Step into the open and try again.');
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
          body={`${fmtDistance(check.distanceM)} from the mine pin${settings.demoLocation !== 'gps' ? '. This is the demo GPS setting, not your real position.' : fix?.accuracyM ? `, accurate to about ${fmtDistance(fix.accuracyM)}.` : '.'}`}
        />
      ) : null}
      {failed ? <Notice tone="warn" title="No position" body={failed} /> : null}

      <Button testID="check-location" label="Check where I am" icon={LocateFixed} kind="ink" loading={busy} onPress={find} />

      <Panel title="The clock-in boundary" flush>
        <View style={styles.fact}>
          <Txt v="strong">{fmtDistance(site.radiusM)} around the mine pin</Txt>
          <Txt v="body" c={color.inkSoft}>
            About {commas(circleAcres(site.radiusM))} acres. You have to be inside it to clock in.
          </Txt>
        </View>
        {away && away.gapM > 0 ? (
          <>
            <Divider inset={space.lg} />
            <View style={styles.fact} testID="site-town">
              <Txt v="strong">{away.name} is outside it</Txt>
              <Txt v="body" c={color.inkSoft}>
                {away.name} is {fmtDistance(away.distanceM)} from the pin, {fmtDistance(away.gapM)} beyond the boundary. A clock-in from there is turned down.
              </Txt>
            </View>
          </>
        ) : null}
        <Divider inset={space.lg} />
        <View style={styles.fact}>
          <Txt v="strong">Your location is read only when you punch</Txt>
          <Txt v="body" c={color.inkSoft}>
            The app never follows you in the background. Clocking out and starting lunch are never blocked: the location is noted, and an off-site clock-out is flagged for review. Lunch ends by itself after 30 minutes, so no location is read then.
          </Txt>
        </View>
      </Panel>

      {supervisor ? (
        <Panel title="Adjust the boundary">
          <View style={styles.stepper}>
            <IconButton testID="radius-minus" icon={Minus} label="Smaller boundary" bg={color.grayTint} onPress={() => setRadius(site.radiusM - 50)} />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Txt v="num" testID="radius-value">{commas(site.radiusM)} m</Txt>
              <Txt v="small" c={color.silica}>{fmtDistance(site.radiusM)} radius, {commas(circleAcres(site.radiusM))} acres</Txt>
            </View>
            <IconButton testID="radius-plus" icon={Plus} label="Larger boundary" bg={color.grayTint} onPress={() => setRadius(site.radiusM + 50)} />
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
