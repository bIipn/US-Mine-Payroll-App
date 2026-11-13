/**
 * App-wide configuration.
 *
 * DEMO_MODE keeps every account and record on the device and unlocks the demo
 * tools (simulated GPS, sample crew, time travel). Set EXPO_PUBLIC_DEMO=0 once
 * the cloud backend is connected.
 */
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO !== '0';

export const APP_NAME = 'US Mine Crew';
export const COMPANY = 'US Mine Corp';
export const SITE_LABEL = 'Ione, California';
