# Field Assets

A free, open-source mobile web app (PWA) for field staff and contractors. It shows the
assets nearest to where you're standing. Location is used only for the search and is never stored.
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

### Sign-in method: password (pilot) or emailed code

`loginMethod` in `app/config.js` chooses how people sign in:

- **`'password'`** (default): you set each person's password in Supabase and give it to
  them. **No emails are sent**, so steps 4 and 5 above (template and SMTP) can wait.
  People can change their password in the app under Settings. To reset a forgotten
  password, run `database/03_admin_set_password.sql`.
- **`'code'`**: a 6-digit code is emailed each time someone signs in. Needs SMTP and the
  template edit (steps 4 and 5). No passwords to manage, which suits contractors.

### Adding and removing people

- **Add someone:** Authentication → Users → **Add user → Create new user**. Enter their
  email and a password, and tick *Auto confirm user*. With password sign-in, give them
  that password (by phone or SMS, separately from the app address). With code sign-in,
  the password is never used, so make it long and random.
- **Their details and access:** Table Editor → `profiles`. A row appears automatically
  for each user. You can set:
  - `full_name`, `company`
  - `role`: `admin`, `staff` or `contractor`. **Set yourself to `admin`** so you can see
    the sync history.
  - `access_expires`: the last day a contractor can use the app
  - `active`: untick to cut someone off immediately
- **Remove someone completely:** delete them under Authentication → Users. Their profile
  is deleted too.

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

- **Sign in** with their email and password (or emailed code). They stay signed in.
- **Find Assets Near Me** gets their current GPS position and lists the closest assets
  with distance and direction. Distances update as they walk.
- Tap an asset for its details, **Show on map**, directions, or to copy its ID.
- **No signal?** The app still opens and shows the last list.

**Privacy:** the phone's location is sent to the database only to run the search. It
isn't recorded or stored anywhere, and the app has no tracking feature.

---

## Before you roll it out

- **Privacy.** The app doesn't record or store anyone's location, so workplace
  surveillance notices for tracking shouldn't be needed. Still tell users that the app
  reads their location to find nearby assets. If an earlier test version recorded any
  locations, `database/05_remove_location_logging.sql` deletes them.
- **Plan.** Supabase's free tier is fine for a pilot. Free projects can be paused after
  a period of inactivity and don't include backups, so look at the Pro plan for
  production use (check current pricing and limits).
- **Security checklist:** sign-ups off, SMTP configured, secret key only on the sync
  machine, yourself set to `admin`, contractors given `access_expires` dates.

---

## Log On / Log Off and Log Incident

**Log On:** expand an asset in the list (or tap it on the map) → **Log On**. Enter at
least one of **Circuit ID, Project ID or Fault ID**. You must be within **50 m** of the
asset, with GPS accurate to ±100 m or better. The asset turns **red / OPEN**.

**Log Off:** shown to the person who logged on. Enter a comment describing the work;
photos aren't needed. The asset turns **amber / CLOSED** for 7 days, then back to
**blue**.

The list shows *Opened by … · time* or *Closed by … · time* under assets with recent jobs.

**Log Incident** (button at the top of the main screen): choose a type, describe the
fault or network issue, and optionally add photos. The person's GPS position is saved
with the report. Incident types are set in `incidentTypes` in `config.js`.

**Settings** (distance limit, GPS accuracy, days to show closed jobs) are in
`app_settings()` at the top of `database/06_work_logs.sql`. Change them there and re-run
the file; the app picks them up automatically.

**Reports with dd/mm/yyyy dates:** Table Editor → `work_logs_report` and `incidents_report`
(export to CSV from there). Dates are stored in Sydney time to the second.

### Setup

1. **Supabase:** run `database/06_work_logs.sql` in the SQL Editor (safe to re-run; it
   upgrades earlier versions).
2. **Worker details:** fill in `full_name`, `mobile_number` and `company` in `profiles`.
3. **ArcGIS work log layer** (point layer). Suggested fields:

   | Field | Type |
   |---|---|
   | field_worker_name, email_address, mobile_number, company | Text |
   | circuit_id, project_id, fault_id | Text |
   | status | Text (short) |
   | work_started_at, work_completed_at | Date |
   | closed_by | Text |
   | work_comments | Text (e.g. length 1000) |
   | duration_mins | **Double** |
   | asset_id, asset_name, asset_layer, work_log_id | Text, *recommended* |

   `sync/create_arcgis_layers.py` creates both layers with these fields in ArcGIS Pro.

4. **ArcGIS incidents layer** (optional; point layer, attachments enabled):
   `incident_type`, `incident_comments` (Text), `reported_at` (Date), `reporter_name`,
   `email_address`, `mobile_number`, `company` (Text), `gps_accuracy_m` (Double),
   `incident_id` (Text, recommended), plus `asset_id`, `asset_name`, `asset_layer`, `work_log_id`
   (Text) for joint issues. Photos are attached with keyword `incident`.

   **Log Joint Incident** (the warning button on a joint you're logged on to) creates an incident
   with `incident_type` = "Joint issue", placed at the joint, linked to the joint and the job.

   Fields missing from either layer are skipped. Share both layers with the sync service
   account, with permission to add, update and add attachments.
5. **config.json:** add the layer URLs, then test with `python work_log_push.py --dry-run`:
   ```json
   "work_logs": { "url": "https://<server>/server/rest/services/<folder>/WorkLogs/FeatureServer/0" },
   "incidents": { "url": "https://<server>/server/rest/services/<folder>/Incidents/FeatureServer/0" }
   ```
6. **Schedule** `sync/run_push.bat` every 10 minutes (Task Scheduler) or `run_push.sh` (cron).
7. **App:** upload `app.js`, `index.html`, `sw.js` and `work.css` to the `app` folder.

If a push fails, the record waits in Supabase and is retried next run. The error is saved
in `arcgis_error`.

**Licensing:** check with your Esri account manager that one service account adding
records collected by people without ArcGIS licences is allowed under your agreement.

---

## Customising

- **Fields shown per asset:** `extra_fields` and `field_labels` in `sync/config.json`.
- **Colours and name:** the variables at the top of `app/styles.css`, `appName` in
  `app/config.js`, `manifest.webmanifest`, and the icons in `app/icons/`.
- **Search behaviour:** `defaultRadiusM`, `maxResults` and `requeryDistanceM` in `app/config.js`.

## Licence

MIT (see `LICENSE`). Your asset data and location logs are not part of the code and
stay private to your Supabase project.
