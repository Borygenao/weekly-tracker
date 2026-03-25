# Weekly Task Tracker

Mobile-first weekly task tracker with:

- work and personal task lanes
- AI-generated daily and weekly reports
- Supabase Auth + realtime sync for tasks and archive
- installable PWA support

## Repos

- Main app: `weekly-tracker`
- Proxy: `wtt-proxy`

## How It Works

- The frontend is a static app hosted from `index.html`.
- AI features call the proxy at `/api/claude`.
- Cloud sync uses Supabase Auth with Google sign-in.
- Task and archive data live in the `tasks` table in Supabase.

## Main Features

- task scheduling by day
- pending / done / blocked task states
- note capture and voice input cleanup
- AI priority detection
- daily and weekly work reports
- monthly calendar view
- archive view backed by local cache and Supabase
- realtime sync across devices

## Setup

### 1. Deploy the proxy

Deploy the `wtt-proxy` repo as a Node web service.

Required environment variables:

- `CLAUDE_API_KEY`: Anthropic API key used for AI features

Recommended environment variables:

- `ALLOWED_ORIGINS`: comma-separated origins allowed to call the proxy
  Example: `https://borygenao.github.io,http://localhost:3000`

### 2. Configure Supabase

1. Open your Supabase project.
2. Go to `Authentication` -> `Providers`.
3. Enable `Google`.
4. Add your site URL and redirect URL for the app.
5. Open the SQL editor and run [`supabase_setup.sql`](/C:/Users/admin/OneDrive/Documents/New%20project/weekly-tracker/supabase_setup.sql).

What that SQL creates:

- `profiles` table with an `is_admin` flag
- `tasks` table for active and archived items
- row-level security policies
- automatic profile creation for new auth users
- admin access for `rbyogena@gmail.com`
- realtime publication for `tasks`

### 3. Configure the app

The Supabase project URL and publishable key are currently embedded in [`index.html`](/C:/Users/admin/OneDrive/Documents/New%20project/weekly-tracker/index.html).

1. Open the app.
2. Open `Settings`.
3. Paste the deployed proxy URL into `AI / API Connection`.
4. Save it.
5. Sign in through `Cloud Sync`.

### 4. Rotate the service role key

The service role key was used for setup planning only and should not be kept as shared plaintext.

After your database is working:

1. Go to Supabase `Settings` -> `API Keys`.
2. Rotate the service role key.
3. Keep it server-side only if you need it later.

## Sync Behavior

- Each device keeps a local cache in `localStorage`.
- Supabase is the shared source of truth across devices.
- Realtime subscriptions refresh tasks when another device changes them.
- Archive data is stored in the same table using `archived_at`.
- Deletes are tracked with tombstones to avoid old device data coming back.

## Deployment Notes

- GitHub Pages can host the main app.
- Render can host the proxy.
- If AI status shows unavailable, check the saved proxy URL and the proxy's allowed origins.
