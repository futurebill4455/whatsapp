# Insurance WhatsApp Bot (v4)

Full-featured insurance desk bot for a **~2GB VPS**: SQLite leads, visual workflow builder, multi-step Health/Vehicle form, company desk phones, and live customer ↔ desk relay.

Requires **Node.js ≥ 22.5** (`node:sqlite` / `--experimental-sqlite`).

## Flow

1. Customer sends a trigger (`Hi` by default) → bot replies with a one-time form link  
2. Customer submits Health or Vehicle details → bot asks for **Yes** / **No** on WhatsApp  
3. On **Yes** → lead is forwarded to the company’s **desk WhatsApp** (Catalog) and a live bridge opens  
4. Messages relay both ways until the customer sends **close** (configurable)

## Features

| Area | What you get |
|------|----------------|
| **QR Connect** (`/`) | Link WhatsApp Web via LocalAuth |
| **Dashboard** | Lead stats, WA status, recent submissions & messages |
| **Workflow** | Drawflow canvas — triggers, form link, confirm, forward |
| **Form Builder** | Coverage options + custom fields |
| **Catalog** | Insurance types, companies + `desk_phone`, fallback numbers |
| **Settings** | Templates, trigger/close keywords, relay delay |
| **Leads** | SQLite submission history |

## Required env

```env
BASE_URL=https://your-vps-or-domain
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...
SESSION_SECRET=...
WA_INIT_DELAY_MS=1000
CHROMIUM_MAX_OLD_SPACE_MB=768
```

`BASE_URL` is **required** (no `localhost` fallback). All form links are built from it only.

## Run locally

```bash
npm install
copy .env.example .env
# set BASE_URL, ADMIN_*, SESSION_SECRET
npm start
# or: npm run seed   then npm run dev
```

Open `/` to scan QR. Admin: `/admin/login`.

## 2GB VPS tips

- Keep `CHROMIUM_MAX_OLD_SPACE_MB=768` (or lower if the host is tighter)
- `WA_INIT_DELAY_MS=1000` lets Express/`/healthz` come up before Chromium
- Leave `PUPPETEER_SINGLE_PROCESS` unset unless you are debugging Chromium crashes
- Desk routing: set each company’s WhatsApp in **Catalog**; use Internal Numbers as fallback

## What is on disk

- **SQLite** (`data/insurance.db`) — settings, catalog, workflows, leads, chat sessions  
- **WhatsApp LocalAuth** (`.wwebjs_auth`) — device link (not chat history)  
- Built CSS under `public/css`

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | `node --experimental-sqlite server.js` |
| `npm run dev` | Same with `--watch` |
| `npm run seed` | Seed admin, defaults, sample catalog/workflow |
| `npm run reset:wa` | Wipe LocalAuth session files |
