/**
 * Android's notification channels: one for each kind of notification the phone lists under Settings, Apps,
 * MineMuster, Notifications, where a person can turn each kind off by itself. The notice that lunch is over has a
 * channel of its own, so turning the deadline reminders off there never silences it.
 *
 * A plain file with no platform split, so the web build, the phone build, the screens and app.json's test all read
 * the same ids and names.
 */
export const LUNCH_OVER_CHANNEL = { id: 'lunch-over', name: 'Lunch is over' } as const;
export const DEADLINE_CHANNEL = { id: 'lunch-deadline', name: 'Lunch deadline reminders' } as const;

/**
 * The one channel every reminder went to before the lunch-over notice had its own. It is taken off the phone, and
 * its id is never used again: Android brings a deleted channel back with whatever the person set on it.
 */
export const OLD_CHANNEL_ID = 'lunch';
