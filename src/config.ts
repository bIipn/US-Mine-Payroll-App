/**
 * App-wide configuration.
 *
 * DEMO_MODE keeps every account and record on the device and unlocks the demo
 * tools (simulated GPS, sample crew, time travel). Set EXPO_PUBLIC_DEMO=0 once
 * the cloud backend is connected.
 */
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO !== '0';

export const APP_NAME = 'US Mine Crew';
/** The legal name, the way it is printed on the pay stub. */
export const COMPANY = 'U.S. Mine Corp.';
export const SITE_LABEL = 'Ione, California';
