/**
 * The MineMuster server. A publishable key is meant to be in client code: row
 * level security on the server is what keeps one company's records from
 * another's. A build can point at another project with the two VITE_ settings.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://jtdidkczekkzompmjfng.supabase.co';
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_njFgKrjUfyvc89_4SROxxw_VjWsZjiE';

/**
 * Billing, on Stripe. These are public addresses, made to be opened by anyone:
 * the payment link that starts the 14-day trial (it takes a card, and Stripe
 * charges it when the trial ends), and the page where a customer signs in to
 * Stripe's billing portal. Opening either is a navigation away from the
 * dashboard, never a call it makes, so the page's connect-src stays as it is.
 * After checkout, Stripe sends the person back to /billing?started=<session>.
 */
export const TRIAL_LINK = 'https://buy.stripe.com/cNidRa6zDa3H5RD03g3ks03';
export const BILLING_PORTAL = 'https://billing.stripe.com/p/login/bJe3cw6zD4JnbbX5nA3ks00';

/**
 * A company has one free trial: the server counts no second one
 * (company_billing). One that has had it starts again on this payment link
 * instead, for the same $300 monthly price with no trial, so the card is
 * charged at checkout. Its metadata, and its subscriptions', is app=minemuster,
 * as on the trial link. Empty until that link is made in Stripe: until then
 * the Billing page tells such a company to write to us instead of offering a
 * checkout, so nobody is sent to a trial that will not open the dashboard.
 */
export const RESTART_LINK = '';

/** Where people write to MineMuster: the contact form on the website. */
export const CONTACT_PAGE = 'https://minemuster.com/contact';

/**
 * The crew's iPhone and Android apps are not in the App Store or Google Play
 * yet: a company's crew app is set up with the company during early access.
 * Said wherever the dashboard sends a supervisor to put the crew on.
 */
export const EARLY_ACCESS = 'During early access we set up the crew’s app with you: write to us at minemuster.com/contact.';
