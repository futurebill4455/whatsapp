# In-memory WhatsApp Bot (Render free tier)

No database. No lead/chat history on disk. Pending forms and live customer↔company chats live **only in RAM** and are lost on restart.

## Flow

1. Customer sends a trigger (`Hi` by default) → bot replies with a one-time form link  
2. Customer submits the form → bot asks for **Yes** / **No** on WhatsApp  
3. On **Yes** → details are forwarded to `COMPANY_PHONE` and a live bridge opens  
4. Messages relay both ways until the customer sends **close**

## Required env

```env
BASE_URL=https://your-app.onrender.com
COMPANY_PHONE=9198XXXXXXXX
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...
SESSION_SECRET=...
```

See `.env.example` for message templates and low-RAM Chromium flags.

## Run locally

```bash
npm install
copy .env.example .env
# set COMPANY_PHONE + BASE_URL
npm start
```

Open `/` to scan QR. Admin: `/admin/login`.

## What is still on disk

- **WhatsApp LocalAuth** (`.wwebjs_auth`) — required to stay linked without re-scanning QR after every deploy. This is device auth, not chat/lead storage.
- Built CSS under `public/css`

## Notes

- Render free tier spin-down clears in-memory bridges; customers must start again with `Hi`.
- Chromium is the main RAM cost; keep `CHROMIUM_MAX_OLD_SPACE_MB≈384` and `WA_INIT_DELAY_MS=3000`.
