/**
 * The MineMuster server. A publishable key is meant to be in client code: row
 * level security on the server is what keeps one company's records from
 * another's. A build can point at another project with the two VITE_ settings.
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://jtdidkczekkzompmjfng.supabase.co';
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_njFgKrjUfyvc89_4SROxxw_VjWsZjiE';
