# MapMiner — Setup Guide

MapMiner has two parts that now talk to each other:

- **`crawler.js`** — a small Node/Express server that geocodes a location (Nominatim, falling back to Photon) and pulls real nearby businesses from OpenStreetMap (via Overpass, with automatic mirror fallback + retries + a JSON file cache).
- **`index.html`** — the dashboard UI. It calls the crawler's API for live search results, and keeps your saved leads, notes, and imported lists in your browser's local storage.

Nothing about the frontend changed to require this — it just calls the same `/api/geocode`, `/api/leads`, and `/api/search` routes crawler.js already exposed.

## 1. Install Node (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs
node -v   # sanity check
```

If you're not on Termux, just make sure Node 18+ is installed (fetch() and AbortController need it).

## 2. Install dependencies

From the folder with `crawler.js` and `package.json`:

```bash
npm install
```

This pulls in the one dependency: `express`.

## 3. Run the crawler

```bash
node crawler.js
```

You should see:

```
MapMiner crawler running at http://127.0.0.1:5000
Health check: http://127.0.0.1:5000/api/health
```

Leave this running in a Termux session (or a background job / `tmux`) while you use the dashboard.

## 4. Open the dashboard

Open `index.html` in your browser (or wherever you're serving it from). Click the small pill in the top-right (or the gear icon) to confirm it says **"Crawler connected"**. If it says **"Crawler offline"**:

- Make sure `node crawler.js` is actually running.
- If the dashboard is on a *different* device than the crawler, open Settings and change the API Base URL from `http://127.0.0.1:5000` to that device's LAN IP, e.g. `http://192.168.1.20:5000`.

## 5. Search

Enter a business type (e.g. `gym`, `cafe`, `dentist`, `lawyer`, `real_estate`, `auto_repair`, `salon`, `hotel`, `retail` — or anything, it'll do a general shop/office/amenity search) and a location, pick a radius, and hit Search. Results come straight from OpenStreetMap. "Near Me" does the same thing but uses your device's GPS instead of typing a city.

## What's new in this pass

- **Live wiring**: search and "Near Me" now call the real crawler endpoints instead of filtering a fake bundled dataset. The old offline demo data is gone.
- **Crawler health check + Settings modal**: a status pill shows if the crawler is reachable, and you can point the dashboard at a different host/port (useful if you wrap this as an APK and run the crawler on a separate box, or on your PC while browsing from your phone).
- **Cache vs. live indicator**: crawler.js now reports whether a result came from its cache or a fresh fetch; the dashboard shows a small badge for it.
- **Lead Quality Score** (Hot / Warm / Cold): computed client-side from how complete each lead's contact info is — no extra API calls.
- **One-tap Call / WhatsApp / Website** buttons on every result row.
- **Per-lead notes**, saved locally and included in CSV exports.
- **Duplicate detection** when saving a lead (matches by name + address).
- **Bulk actions**: copy all phone numbers, copy all websites, or save every visible result to your Vault in one click.
- **Cold outreach message generator**: one click drafts (and copies) a starter outreach message per lead — edit the bracketed parts before sending.
- **Sort by quality / name / distance**, plus a "Hot Leads Only" filter.
- **Recent search history** saved locally for faster re-runs.
- **Keyboard shortcuts**: `/` focuses the search box, `Esc` closes any open modal.
- **Support / Donate**: a Flutterwave-powered tip button in the header, footer, a floating corner button, and a one-time banner that appears after your first successful search (dismissible, never blocks the app). Amounts are open — pick a preset or type your own, in NGN or USD.

## Notes on the donation flow

- Uses Flutterwave's inline checkout (`checkout.flutterwave.com/v3.js`) with your public key baked into the page. Public keys are meant to be client-side — that part's normal.
- There's no backend order-verification step here (no secret key, no webhook) since this is a simple one-off tip flow with no deliverable to unlock. If you ever want to *gate* a feature behind a successful payment, you'd need a small server-side verification step using your Flutterwave secret key — happy to add that if you get there.
