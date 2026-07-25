# WhatsApp Lead Intake System

Secure WhatsApp automation for insurance lead capture, catalog routing, and two-way desk relay.

## Features

- **QR WhatsApp link** + colorful admin dashboard
- **Common access code** (one shared code for all senders — no Users whitelist)
- **Chat Flow** admin page to edit the code and bot messages
- **Visual workflow builder** (Drawflow)
- **Multi-step insurance form** (advisor, type, company, premium, members, duration, review)
- **Catalog routing** to company desk WhatsApp numbers
- **Two-way native forward relay** with typing + unique jitter (up to 30s)
- **Close / CLS** silent session end

## Requirements

- Node.js **≥ 22.5** (for `node:sqlite`)
- Chrome/Chromium for WhatsApp Web

## Setup

```bash
npm install
cp .env.example .env
npm run seed
npm start
```

Open http://localhost:3000 — scan QR, then login at `/admin/login`.

Default admin (from `.env`):

- Username: `admin`
- Password: `ChangeMe123!`

Configure the shared access code and WhatsApp replies under **Admin → Chat Flow** (default code: `INSU2026`).

## Flow

1. Anyone sends the **common access code** on WhatsApp  
2. Bot replies with configured messages + form URL (anti-ban paced)  
3. Customer completes form → lead routes to company desk  
4. Live two-way relay until customer types **Close** or **CLS**
