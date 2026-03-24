# Weekly. — Task Tracker

A mobile-first weekly task tracker with AI-powered daily and weekly reports, Google Sheets sync, and a clean dark UI.

## Features

- **Work & Personal tasks** — separate categories with color coding
- **Priority detection** — AI automatically labels tasks High / Medium / Low
- **Schedule by day** — assign tasks to specific days of the week
- **3-state checkbox** — cycle between Pending → Done → Blocked
- **Notes with voice input** — dictate notes, AI cleans them up
- **Daily report** — professional end-of-day work update (Completed, Blockers, Up Next)
- **Weekly report** — Completed and Incomplete summary for the week
- **Monthly calendar** — visual performance indicator per day
- **Google Sheets sync** — tasks sync across all your devices in real time
- **PWA** — installable on iPhone and Android from the browser

## Setup

### 1. AI Proxy (Render.com)

The app uses a proxy server to call the Claude API securely.

1. Deploy the `wtt-proxy` repo to [Render.com](https://render.com) as a Web Service
2. Add environment variable: `GEMINI_API_KEY` = your key from [Google AI Studio](https://aistudio.google.com)
3. Copy your Render URL (e.g. `https://wtt-proxy.onrender.com`)

### 2. App Configuration

1. Open the app
2. Tap ⚙ Settings
3. Paste your Render URL into **AI Proxy URL** → Save
4. Optionally paste your Google OAuth Client ID to enable cross-device sync

### 3. Google Sheets Sync (optional)

Follow the instructions in `SETUP.md` to configure Google OAuth for cross-device task sync.

## Install on iPhone

1. Open the app URL in Safari
2. Tap **Share → Add to Home Screen**
3. Tap **Add**

The app installs as a PWA with a custom icon and runs fullscreen.

## Tech Stack

- Vanilla HTML / CSS / JavaScript — no frameworks
- Google Sheets API for sync
- Claude for AI features via the proxy server
- Hosted on GitHub Pages
- AI proxy hosted on Render.com

## AI Proxy

The proxy server lives in a separate repo: `wtt-proxy`. It receives requests from the app, forwards them to the Claude API with your key, and returns the response. Your API key never touches the browser.
