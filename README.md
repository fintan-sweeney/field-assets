# Field Assets

A free, open-source mobile web app (PWA) for field staff and contractors. It shows the
assets nearest to where you're standing and logs your location while tracking is on.
Asset data comes from ArcGIS Enterprise; field users don't need ArcGIS licences.

```
 ArcGIS Enterprise              Supabase (Postgres + PostGIS)            Phones
 ┌──────────────────┐  daily   ┌──────────────────────────────┐  HTTPS  ┌────────────────┐
 │ Asset layers     │ ───────► │ assets         (read-only)   │ ◄─────► │ Field Assets   │
 │ (feature/map     │  sync    │ location_log   (per user)    │         │ PWA            │
 │  services)       │  script  │ profiles       (who's in)    │         │ invite-only    │
 └──────────────────┘          └──────────────────────────────┘         └────────────────┘
   one service account            Row Level Security decides who
   reads the layers                can see and write what
```

| Folder | What it is |
|---|---|
| `database/01_schema.sql` | Tables, security rules and functions. Run once in Supabase. |
| `sync/` | Python script that copies your ArcGIS layers into Supabase daily. No extra packages needed. |
| `app/` | The mobile app. Plain HTML/CSS/JS, no build step. Host on any HTTPS web server. |

**Try the app first:** in the `app` folder run `python -m http.server 8000`, then open
<http://localhost:8000/?demo> in a browser. Demo mode uses made-up assets around your
position; sign in with any email and the code `123456`.

---

## Step 1: Set up Supabase (about 20 minutes)

1. Create a free account at <https://supabase.com> and a new project. Choose the
   **Sydney (ap-southeast-2)** region so the data is stored in Australia.
2. Open **SQL Editor → New query**, paste the whole of `database/01_schema.sql`, and click
   **Run**. (Safe to run again later if you change it.)
3. **Turn off public sign-ups:** Authentication → Sign In / Providers → turn off
   *Allow new users to sign up*. Leave the **Email** provider on.
4. **Send a code instead of a link:** Authentication → Emails → *Magic Link* template.
   Replace the body with something like:

   ```html
   <h2>Your Field Assets sign-in code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   <p>It expires in 1 hour. If you didn't ask for it, ignore this email.</p>
   ```

   Codes are used instead of links because an app added to an iPhone home screen
   doesn't share its login with Safari: a tapped link would sign people in to Safari,
   not the app.
5. **Set up email sending (SMTP):** Supabase's built-in email only sends a handful of
   emails per hour and is meant for testing. Under Authentication → Emails → SMTP
   Settings, use your company mail server (e.g. Microsoft 365) or a mail service.
6. **Get your keys:** Project Settings → API Keys.
   - The **publishable** key (or legacy *anon* key) goes in the app's `config.js`.
   - The **secret** key (or legacy *service_role* key) goes only in the sync script's
     config. It bypasses all security rules: never put it in the app or share it.

### Adding and removing people

- **Add someone:** Authentication → Users → **Add user → Create new user**. Enter their
  email, any long random password (they never use it), and tick *Auto confirm user*.
  Then send them the app's web address. They sign in with an emailed code.
- **Their details and access:** Table Editor → `profiles`. A row appears automatically
  for each user. You can set:
  - `full_name`, `company`
  - `role`: `admin`, `staff` or `contractor`. **Set yourself to `admin`** so you can see
    everyone's location history.
  - `access_expires`: the last day a contractor can use the app
  - `active`: untick to cut someone off immediately
- **Remove someone completely:** delete them under Authentication → Users. Their profile
  and location history are deleted too.

---

## Step 2: Set up the daily sync from ArcGIS Enterprise (about 30 minutes)

The sync runs on a computer **inside your network** that can reach your ArcGIS server
and also make outbound HTTPS connections to `*.supabase.co`. A GIS or utility server is
ideal. It needs Python 3.8 or newer; the Python that comes with ArcGIS Pro works.

1. **Create one ArcGIS account for the sync**, e.g. `svc_field_assets_sync`, using a
   built-in (not SAML/Windows) login. A Viewer user type is enough. Share the asset
   layers with it. This one account is the only ArcGIS licence the setup uses.
2. Copy `sync/config.example.json` to `sync/config.json` and fill it in:
   - `token_url`: for a federated server, your Portal's
     `https://<portal-host>/<portal-web-adaptor>/sharing/rest/generateToken`.
     For a standalone ArcGIS Server, use
     `https://<server-host>/<server-web-adaptor>/tokens/generateToken`.
     Leave it out if the services don't need a login.
   - `username` / `password`: the sync account. (Or set the `ARCGIS_PASSWORD`
     environment variable and leave `password` empty.)
   - `supabase.url` and `secret_key`. (Or use the `SUPABASE_SECRET_KEY` environment variable.)
   - `layers`: one entry per asset layer. `url` is the layer's REST endpoint ending in
     the layer number (`.../FeatureServer/0` or `.../MapServer/3`). Map the fields:

     | Setting | Meaning |
     |---|---|
     | `name` | Label for the layer in the app, e.g. `Poles`. Must stay the same between runs. |
     | `id_field` | Field holding the asset ID (must be unique within the layer) |
     | `name_field` | Field shown as the asset's title (optional, defaults to the ID) |
     | `type_field` / `type_value` | Field holding the asset type, or a fixed value for the whole layer |
     | `status_field` | Status field (optional) |
     | `extra_fields` | Other fields to show when an asset is tapped |
     | `field_labels` | Friendly names for those fields |
     | `where` | Filter, e.g. `STATUS <> 'Removed'` |

3. **Test without writing anything:**
   `python arcgis_sync.py --dry-run`
   It will tell you if a field name is wrong and list the available fields.
4. **Run it for real:** `python arcgis_sync.py`. Then check Table Editor → `assets`
   in Supabase.
5. **Schedule it daily.** On Windows, in Task Scheduler create a task that runs
   `sync\run_sync.bat` daily (e.g. 5:00 am), set to *Run whether user is logged on or not*.
   On Linux, use the cron line in `sync/run_sync.sh`. Output goes to `sync/logs/sync.log`.
6. **Protect `config.json`.** It contains the Supabase secret key. Restrict the file to
   the account that runs the task, or use environment variables instead.

**What the sync does:** each run reads every feature from each layer, updates the copy
in Supabase, and removes assets that no longer exist in ArcGIS. As a safety check, if a
run sees less than half the assets currently stored (e.g. ArcGIS returned an error), it
stops without deleting anything. Use `--force` if a big drop is genuine. Each run is
recorded in the `sync_runs` table.

---

## Step 3: Publish the app (about 15 minutes)

1. Edit `app/config.js`: set `supabaseUrl` and `supabaseKey` (the **publishable** key),
   and adjust the search radius and logging intervals if you like.
2. Host the `app` folder on any web server with **HTTPS** (required for location and
   for installing the app). Free options include Cloudflare Pages, Netlify and GitHub
   Pages, or your own IIS/web server.
3. **Install it on phones:**
   - **iPhone:** open the address in Safari → Share → **Add to Home Screen**.
   - **Android:** open it in Chrome → menu → **Install app** (or Add to Home screen).
4. When you change the app later, increase `VERSION` in `app/sw.js` so phones pick up
   the new version.

---

## How it works for users

- **Sign in** with their email and the 6-digit code they're emailed. They stay signed in.
- **Near me** lists the closest assets with distance and direction, refreshing as they
  move. Tap an asset for details, directions, or to see it on the map.
- **Start tracking** records their position about every minute, or sooner if they move
  25 m or more. The first time, they see a notice explaining what is recorded.
- **No signal?** The app still opens and shows the last list. Location points are saved
  on the phone and uploaded when signal returns.

**Important limitation:** a web app can only read the location **while it is open on
screen**. If the phone is locked or they switch apps, logging pauses until they come
back. The *Keep screen on while tracking* setting helps. If you need logging in the
background all day, the next step is a native app (e.g. React Native with Expo) that
uses this same database and sync unchanged.

---

## Viewing location history

- **Supabase:** Table Editor → `location_log_view` shows who, when, where and accuracy.
  Filter and **Export to CSV**, then add the CSV to ArcGIS Pro as XY data.
- **ArcGIS Pro directly:** Pro can connect to PostgreSQL databases. Use the connection
  details from Supabase (Project Settings → Database), then check the supported
  PostgreSQL versions for your ArcGIS Pro release.
- Only users with role `admin` can read other people's locations. Everyone else can only
  read their own.

---

## Before you roll it out

- **Workplace surveillance and privacy.** In NSW, the *Workplace Surveillance Act 2005*
  generally requires **written notice at least 14 days before** tracking employees,
  covering what's tracked, how and when. Consider the *Privacy Act 1988* (collection
  notice, retention, access) and include tracking in contractor agreements. Have HR or
  legal review your approach. The in-app notice text is in `config.js`.
- **Retention.** Decide how long to keep location history. The schema file ends with
  an example clean-up query you can schedule.
- **Plan.** Supabase's free tier is fine for a pilot. Free projects can be paused after
  a period of inactivity and don't include backups, so look at the Pro plan for
  production use (check current pricing and limits).
- **Security checklist:** sign-ups off, SMTP configured, secret key only on the sync
  machine, yourself set to `admin`, contractors given `access_expires` dates.

---

## Customising

- **Fields shown per asset:** `extra_fields` and `field_labels` in `sync/config.json`.
- **Colours and name:** the variables at the top of `app/styles.css`, `appName` in
  `app/config.js`, `manifest.webmanifest`, and the icons in `app/icons/`.
- **Search behaviour:** `defaultRadiusM`, `maxResults` and `requeryDistanceM` in `app/config.js`.

## Licence

MIT (see `LICENSE`). Your asset data and location logs are not part of the code and
stay private to your Supabase project.
