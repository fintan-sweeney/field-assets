// Field Assets - app settings. Edit these for your organisation.
// The Supabase "publishable" key (or legacy "anon" key) is safe to put here:
// it only allows what the database's Row Level Security permits.
// NEVER put the secret / service_role key in this file.

window.APP_CONFIG = {
  appName: 'Field Assets',

  supabaseUrl: 'https://euproiigzkzbrdnpctto.supabase.co',
  supabaseKey: 'sb_publishable_pbBN0iVn6dV-jRoR5RRsbg_wgkrWMjG',

  // Nearby asset search
  defaultRadiusM: 100,        // search radius in metres (user can change)
  maxResults: 30,              // assets shown in the list
  requeryDistanceM: 40,        // re-run the search after moving this far

  // Location logging while tracking is on
  logMinIntervalSec: 60,       // log at least this often...
  logMinDistanceM: 25,         // ...or sooner if the user moves this far
  maxAccuracyM: 150,           // ignore GPS fixes worse than this

  // Shown to users before they start tracking for the first time
  trackingNotice:
    'While tracking is on, this app records your location every minute or so ' +
    'and stores it against your name. Tracking only runs while the app is open ' +
    'on screen, and you can turn it off at any time.'
};
