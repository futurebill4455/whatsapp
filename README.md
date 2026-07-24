# WhatsApp Lead Intake System

Secure WhatsApp automation for insurance lead capture, catalog routing, and two-way desk relay.

## Features

- **QR WhatsApp link** + colorful admin dashboard
- **Whitelist users** with unique access codes (bot silent until exact code)
- **Visual workflow builder** (Drawflow) with AI-assist node stub
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

Demo access user (seeded): check console / Users admin page.

## Flow

1. Authorized user sends **ACCESS_CODE** on WhatsApp  
2. Bot sends bare form URL (anti-ban paced)  
3. Customer completes form → lead routes to company desk  
4. Live two-way relay until customer types **Close** or **CLS**
