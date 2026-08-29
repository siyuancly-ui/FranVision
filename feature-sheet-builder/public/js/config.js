/*
 * Runtime config. If `supabaseUrl` + `supabaseAnonKey` are set, the app
 * talks directly to Supabase (production / hosted). If they are blank,
 * store.js falls back to the local Node server API (dev: `node server.js`).
 *
 * The anon key is a PUBLISHABLE key -- it is meant to live in client code
 * and is gated by the Row Level Security policies on the Supabase project.
 * Do NOT put the `service_role` / secret key here.
 */
window.FSB_CONFIG = {
  // Franky's Supabase project (owner of the data + hosting).
  supabaseUrl: 'https://papaswihicvajzcubbri.supabase.co',
  supabaseAnonKey: 'sb_publishable_4Ct6GKlbNJbPEFzFL-CN_A_DudWMwBy',
  photosBucket: 'photos',
};
