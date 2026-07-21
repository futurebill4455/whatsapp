# Insurance WhatsApp Automation

Production-ready Node.js app for a small insurance business: connect a normal WhatsApp number via QR, collect leads through a web form, confirm on WhatsApp, and forward sorted details to internal desk numbers.

## Features

- **Web QR interface** — scan once from the browser; live updates via Socket.IO
- **Persistent session** — `whatsapp-web.js` + `LocalAuth` keeps WhatsApp online after the page is closed
- **Customer flow**
  1. Customer sends `Hi` (or other configured keywords)
  2. Bot replies with a unique web form link
  3. Customer submits Name, Insurance Type, Company
  4. Bot sends a summary and asks to reply `Yes`
  5. On `Yes`, details are forwarded to the matching internal WhatsApp number
- **Admin panel** — secure login to edit chat flows, insurance types, companies, desk numbers, and message templates (no code changes)

## Stack

| Layer | Tech |
|--------|------|
| Server | Node.js, Express |
| WhatsApp | `whatsapp-web.js`, LocalAuth, Puppeteer |
| DB | SQLite (built-in `node:sqlite`, Node 22.5+) |
| UI | EJS + Tailwind CSS (compiled CLI build) |
| Workflow | Drawflow visual canvas + graph engine |
| Realtime | Socket.IO |

CSS is built with `npm run build:css` (also runs automatically via `prestart` before `npm start`). During UI work, run `npm run watch:css` in a second terminal.

## Project structure

```
whatsapp/
├── server.js                 # App entry
├── package.json
├── .env.example
├── data/                     # SQLite DB (created at runtime)
├── .wwebjs_auth/             # WhatsApp session (created at runtime)
├── public/
│   ├── css/app.css
│   └── js/app.js
├── views/
│   ├── qr.ejs                # QR connect page
│   ├── form.ejs              # Customer form
│   ├── form-done.ejs
│   ├── error.ejs
│   ├── partials/nav.ejs
│   └── admin/                # Login, dashboard, settings, flow, catalog, submissions
└── src/
    ├── config/db.js
    ├── models/index.js
    ├── middleware/auth.js
    ├── routes/index.js
    ├── services/whatsapp.js
    └── utils/seed.js
```

## Prerequisites

- **Node.js 22.5+** (uses built-in `node:sqlite`)
- **Chrome/Chromium** available for Puppeteer (bundled with `whatsapp-web.js` in most cases)
- A phone with WhatsApp to scan the QR code

## Local setup

### 1. Install dependencies

```bash
cd whatsapp
npm install
```

### 2. Configure environment

```bash
copy .env.example .env
```

Edit `.env`:

```env
PORT=3000
BASE_URL=http://localhost:3000
SESSION_SECRET=replace-with-a-long-random-string
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe123!
NODE_ENV=development
```

> **Important:** `BASE_URL` must be reachable by the customer’s phone when they open the form link. For local testing with a real phone, use a tunnel (see below).

### 3. Start the server

```bash
npm start
```

Or with auto-reload:

```bash
npm run dev
```

Open:

- QR connect: [http://localhost:3000](http://localhost:3000)
- Admin: [http://localhost:3000/admin/login](http://localhost:3000/admin/login)

Default admin credentials come from `.env` (`admin` / `ChangeMe123!` unless changed). Change them before any real use.

### 4. Link WhatsApp

1. Open the home page
2. Wait for the QR code
3. On your phone: **WhatsApp → Settings → Linked devices → Link a device**
4. Scan the QR
5. Status should show **ready** — you can close the browser; the Node process keeps the session

### 5. Configure desks & catalog

In **Admin → Catalog**:

- Set real **internal WhatsApp numbers** (format `919876543210`, no `+`)
- Adjust Health / Vehicle types and companies as needed

In **Admin → Chat Flow** and **Settings**, customize triggers and message templates.

### 6. Test the full flow

1. From another WhatsApp account, message the linked number: `Hi`
2. Open the form link on your phone/browser
3. Submit details
4. Reply `Yes` on WhatsApp
5. Confirm the lead appears in Admin → Submissions and is forwarded to the desk number

## Exposing the form link to phones (local)

Phones cannot open `http://localhost:3000`. Use a tunnel and set `BASE_URL` to that URL:

**ngrok**

```bash
ngrok http 3000
```

Then set:

```env
BASE_URL=https://YOUR-SUBDOMAIN.ngrok-free.app
```

Restart the server after changing `BASE_URL`.

## Deploy (VPS / cloud)

Recommended: a small Linux VPS (Ubuntu 22.04+) with Node 18+.

### Notes for WhatsApp Web bots

- Prefer a **persistent VM** (not serverless) — Puppeteer + LocalAuth need disk and a long-running process
- Keep `.wwebjs_auth/` on persistent storage; do not wipe it on redeploy
- Use HTTPS for `BASE_URL` in production
- Run under a process manager (`pm2` or systemd)

### Example with PM2

```bash
# on the server
git clone <your-repo> && cd whatsapp
cp .env.example .env
# edit .env — set BASE_URL to https://your-domain.com
npm install
sudo apt-get install -y chromium-browser   # if needed
npm install -g pm2
pm2 start server.js --name insurance-wa
pm2 save
pm2 startup
```

### Nginx reverse proxy (sketch)

```nginx
server {
  listen 80;
  server_name your-domain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then enable HTTPS with Certbot.

### Puppeteer on Linux

If Chromium fails to launch, install dependencies and optionally set:

```env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

You can also pass `executablePath` in `src/services/whatsapp.js` if required by your host.

## Customer journey (summary)

```
Customer ──Hi──► Bot ──form link──► Web form
                                      │
                                   Submit
                                      ▼
              Bot ◄── confirmation ── App
                │
             Reply Yes
                ▼
              App ── forwards lead ──► Internal desk WhatsApp
                │
             Success reply to customer
```

## Admin capabilities (no code edits)

| Area | What you can change |
|------|---------------------|
| Chat Flow | Trigger keywords & reply templates |
| Catalog | Insurance types, companies, internal numbers |
| Settings | Business name, confirmation/forward/success messages |
| Dashboard | Live WA status, lead stats, message log |
| Relink | Log out WhatsApp session and scan a new QR |

## Security checklist

- Change `ADMIN_PASSWORD` and `SESSION_SECRET` immediately
- Do not commit `.env` or `.wwebjs_auth/`
- Restrict admin routes behind HTTPS
- Use a dedicated business WhatsApp number (risk of ban exists with unofficial WhatsApp Web automation — use responsibly and at low volume)

## Visual workflow builder (n8n-style)

Open **Admin → Workflow** (`/admin/workflow`) for a drag-and-drop canvas powered by [Drawflow](https://github.com/jerosoler/Drawflow).

| Node | Role |
|------|------|
| When chat message received | Trigger on keywords (`hi`, etc.) |
| Send Web Form Link | WhatsApp message with `{{form_link}}` |
| Receive Form Submit | Pauses until customer submits the web form |
| Condition / If-Else | Branches on Yes / No reply |
| Forward to Internal Desk | Sends lead to configured desk number |
| Send Text Message | Generic WhatsApp text (e.g. cancel path) |

**Save** persists the Drawflow JSON graph to SQLite (`workflows.graph_json`). **Set active** makes that graph the live automation engine for inbound WhatsApp messages.

Execution state is tracked in `workflow_runs` (waiting for `form_submit` or `yes_no`).

## Clean restart (fix “Could not link device”)

WhatsApp rejects expired/stale QR codes and corrupted LocalAuth folders with *Could not link device, try again later*. Do a full clean restart:

```powershell
# 1) Stop the running Node server (Ctrl+C in that terminal, or):
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force

# 2) From the project folder — wipe auth + cache
cd C:\Users\LENOVO\OneDrive\Desktop\whatsapp
npm run reset:wa

# 3) Start fresh
npm start
```

Then open http://localhost:3000, wait until a **new** QR appears, and scan it within ~20 seconds via **Linked devices → Link a device**.

You can also click **Reset session** on the QR page (or **Reset session files** in Admin) without stopping the process.

Optional env flags in `.env`:

```env
# If linking fails on Linux/Docker, try enabling single-process:
# PUPPETEER_SINGLE_PROCESS=1
# On Windows, single-process is OFF by default (it crashes Chromium).

# Use system Chrome instead of bundled Chromium:
# PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

# Debug with a visible browser window:
# PUPPETEER_HEADLESS=false
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| “Could not link device” | `npm run reset:wa`, restart, scan the **latest** QR immediately; do not scan a refreshed/old image |
| QR never appears | Wait for Puppeteer; check server logs; try `PUPPETEER_NO_SINGLE_PROCESS=1` |
| Form link fails on phone | Set `BASE_URL` to a public/tunnel URL |
| Forward not received | Verify desk number format (`91…`) and that the desk has WhatsApp |
| `node:sqlite` / experimental warning | Use Node 22.5+; scripts already pass `--experimental-sqlite` |
| Session logged out | Reset session, then scan a fresh QR |

## License

MIT
