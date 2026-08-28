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
  supabaseUrl: 'https://obzxjgzdtylmkwjejgbl.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ienhqZ3pkdHlsbWt3amVqZ2JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5Mjc5MTUsImV4cCI6MjEwMzUwMzkxNX0.nYh0JsORFHA5SGDdqQMy4ue3Uuf6gFXsSFJf2Uw1ar8',
  photosBucket: 'photos',
};
