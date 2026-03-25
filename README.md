# Weekly Task Tracker

Mobile-first weekly task tracker with:

- work and personal task lanes
- AI-generated daily and weekly reports
- Google Sheets sync for cross-device use
- installable PWA support

## Repos

- Main app: `weekly-tracker`
- Proxy: `wtt-proxy`

## How It Works

- The frontend is a static app hosted from `index.html`.
- AI features call the proxy at `/api/claude`.
- Google Sheets sync uses Google's browser OAuth flow directly in the app.
- The proxy's Google token-store routes are disabled by default and are not required for normal Sheets sync.

## Main Features

- task scheduling by day
- pending / done / blocked task states
- note capture and voice input cleanup
- AI priority detection
- daily and weekly work reports
- monthly calendar view
- archive view backed by local cache and Google Sheets

## Setup

### 1. Deploy the proxy

Deploy the `wtt-proxy` repo as a Node web service.

Required environment variables:

- `CLAUDE_API_KEY`: Anthropic API key used for AI features

Recommended environment variables:

- `ALLOWED_ORIGINS`: comma-separated origins allowed to call the proxy
  Example: `https://borygenao.github.io,http://localhost:3000`

Optional environment variables for the disabled-by-default Google token store:

- `ENABLE_GOOGLE_TOKEN_STORE=true`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `TOKEN_STORE_FILE`

Notes:

- `/api/auth/*` routes stay off unless `ENABLE_GOOGLE_TOKEN_STORE=true`.
- If you enable that token store on Render and need persistence across restarts, point `TOKEN_STORE_FILE` at persistent disk storage.

### 2. Configure the app

1. Open the app.
2. Open `Settings`.
3. Paste the deployed proxy URL into `AI / API Connection`.
4. Save it.

### 3. Configure Google Sheets sync

The app uses the Google browser OAuth client configured in `index.html`.

To use your own Google project:

1. Create an OAuth client in Google Cloud.
2. Replace `GOOGLE_CLIENT_ID` in `index.html`.
3. Add your deployed app origin to the OAuth allowed origins.
4. Sign in from each device that should sync.

## Sync Behavior

- Each device keeps a local cache in `localStorage`.
- Sync merges local and remote tasks using `updatedAt`.
- Writes no longer clear the sheet first; the app writes merged rows, then trims stale tail rows only after a successful write.
- Archive data is also cached locally and mirrored to a separate `Archive` tab in the same spreadsheet.

## Deployment Notes

- GitHub Pages can host the main app.
- Render can host the proxy.
- If AI status shows unavailable, check the saved proxy URL and the proxy's allowed origins.
