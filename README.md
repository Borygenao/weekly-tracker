# Weekly Task Tracker

Mobile-first weekly task tracker with:

- work and personal task lanes
- AI-generated daily and weekly reports
- Supabase realtime sync across devices
- installable PWA support

## Repos

- Main app: `weekly-tracker`
- Proxy: `wtt-proxy`

## How It Works

- The frontend is a static app hosted from `index.html`.
- AI features call the proxy at `/api/claude`.
- Task sync, archive history, and auth use Supabase.
- Google Sheets is no longer part of normal sync. It is only used by an admin-only one-time import action inside the app.

## Main Features

- task scheduling by day
- pending / done / blocked task states
- note capture and voice input cleanup
- AI priority detection
- daily and weekly work reports
- monthly calendar view
- archived tasks stored in the same cloud dataset as active tasks

## Setup

### 1. Deploy the proxy

Deploy the `wtt-proxy` repo as a Node web service.

Required environment variables:

- `CLAUDE_API_KEY`: Anthropic API key used for AI features

Recommended environment variables:

- `ALLOWED_ORIGINS`: comma-separated origins allowed to call the proxy
  Example: `https://borygenao.github.io,http://localhost:3000`

### 2. Prepare Supabase

1. Create a Supabase project.
2. Run [`supabase_setup.sql`](./supabase_setup.sql) in the Supabase SQL editor.
3. In `Authentication -> Providers -> Google`, enable Google sign-in.
4. Add your app URL and Supabase auth callback URL to the Google OAuth app.

The current frontend is configured for:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

inside [`index.html`](./index.html).

### 3. Configure the app

1. Open the app.
2. Open `Settings`.
3. Paste the deployed proxy URL into `AI / API Connection`.
4. Save it.
5. Sign in with Google from the sync section.

## Sync Model

- Signed-out users see the app shell, but cloud task data stays locked.
- Signed-in users load tasks from Supabase only.
- Active tasks, archived tasks, and tombstones all live in the `tasks` table.
- Realtime events refresh the local view across devices.
- Deleted tasks are kept as tombstones so stale devices do not recreate them.

## Google Sheets Import

- The `Import Sheets` button appears only for the admin account.
- Import reads the existing Google Sheet named `Weekly Tracker Task Database`.
- Active and archived rows are imported into Supabase.
- Re-running import is safe: rows are merged by task id and latest timestamp.

## Deployment Notes

- GitHub Pages can host the main app.
- Render can host the proxy.
- If AI status shows unavailable, check the saved proxy URL and the proxy's allowed origins.
