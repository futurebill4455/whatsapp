# Lean WhatsApp Bot

Minimal Node.js WhatsApp bot optimized for **Render free tier** (low RAM): QR connect, receive messages, simple auto-replies. No workflows, forms, catalog, or desk bridge.

## What it does

1. Open `/` and scan the QR to link WhatsApp
2. Customer sends `Hi` / `Hello` → welcome reply (editable in Admin → Settings)
3. Any other message → default reply
4. Messages are logged for the admin dashboard

## Stack

| Layer | Tech |
|--------|------|
| Server | Node.js 22.5+, Express |
| WhatsApp | `whatsapp-web.js` + LocalAuth + `puppeteer-core` + `@sparticuz/chromium` |
| DB | SQLite (`node:sqlite`) — admins, settings, message_log only |
| UI | EJS + Tailwind |
| Realtime | Socket.IO (QR / status) |

## Local setup

```bash
npm install
copy .env.example .env
npm start
```

Open `http://localhost:3000` for QR. Admin: `/admin/login` (defaults from `.env`).

## Render notes

- Chromium dominates RAM; keep `CHROMIUM_MAX_OLD_SPACE_MB` around `384`
- `WA_INIT_DELAY_MS=3000` lets health checks pass before WhatsApp starts
- Use `/healthz` for liveness

See `.env.example` for all low-RAM / timeout flags.

## Project layout

```
server.js
src/
  config/db.js
  models/index.js
  routes/index.js
  services/whatsapp.js
  services/chromiumLaunch.js
  utils/seed.js
  middleware/auth.js
views/          # QR, admin login/dashboard/settings
public/         # css, js/app.js
```
