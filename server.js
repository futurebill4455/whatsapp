require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

require('./src/config/db');
const { seed } = require('./src/utils/seed');
seed();

const whatsapp = require('./src/services/whatsapp');
const routes = require('./src/routes');
const campaignRoutes = require('./src/routes/campaigns');
const { getCampaignRunner } = require('./src/services/campaignRunner');
const { getHistoryCleanup } = require('./src/services/historyCleanup');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Bust browser CSS cache after each deploy / Tailwind rebuild
try {
  const cssPath = path.join(__dirname, 'public', 'css', 'tailwind.css');
  app.locals.cssVersion = String(fs.statSync(cssPath).mtimeMs | 0);
} catch (_) {
  app.locals.cssVersion = String(Date.now());
}
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

app.use(routes);
app.use(campaignRoutes);

whatsapp.attachSocket(io);
whatsapp.init().catch((err) => {
  console.error('[Boot] WhatsApp init failed (process stays up):', err.message);
  console.error(err.stack);
  console.error(
    '[Boot] Try Admin → Reset session, or POST /api/whatsapp/reconnect, then GET /api/whatsapp/qr'
  );
});

// PM2-persistent background workers
try {
  getCampaignRunner(whatsapp).start();
  getHistoryCleanup().start();
} catch (err) {
  console.error('[Boot] background workers failed:', err.message);
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const { getBaseUrl } = require('./src/config/baseUrl');
  const publicBase = getBaseUrl();
  console.log(`Lead Intake System listening on 0.0.0.0:${PORT}`);
  console.log(`Public form base URL: ${publicBase}`);
  if (/localhost|127\.0\.0\.1/i.test(publicBase)) {
    console.warn(
      '[Config] Form links still use localhost — set BASE_URL or Chat Flow → Public base URL to your public IP/domain.'
    );
  }
});
