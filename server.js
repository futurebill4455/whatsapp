require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const { seed } = require('./src/utils/seed');
const routes = require('./src/routes');
const whatsapp = require('./src/services/whatsapp');

seed();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CSS_DIR = path.join(PUBLIC_DIR, 'css');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve /public at site root so /css/*.css and /js/*.js resolve in production
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error('[Static] Missing public directory:', PUBLIC_DIR);
} else {
  console.log('[Static] Serving', PUBLIC_DIR);
  for (const name of ['tailwind.css', 'app.css', 'workflow.css']) {
    const file = path.join(CSS_DIR, name);
    console.log(
      `[Static] ${name}:`,
      fs.existsSync(file) ? `${fs.statSync(file).size} bytes` : 'MISSING'
    );
  }
}

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    fallthrough: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      }
    },
  })
);

// Explicit CSS mount (belt-and-suspenders for Render reverse proxies)
app.use(
  '/css',
  express.static(CSS_DIR, {
    index: false,
    fallthrough: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    },
  })
);

app.use(
  session({
    name: 'insurance.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.SECURE_COOKIE === '1',
    },
  })
);

app.use((req, res, next) => {
  try {
    res.locals.businessName = require('./src/models').Settings.get(
      'business_name',
      'Insurance Bot'
    );
  } catch (_) {
    res.locals.businessName = 'Insurance Bot';
  }
  next();
});

// Liveness — Render / proxies can hit this without loading WhatsApp
app.get('/healthz', (_req, res) => {
  res.status(200).type('text').send('ok');
});

app.use(routes);

function sendErrorPage(res, status, title, message) {
  const safe = String(message || 'Error')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (res.headersSent) return;
  res
    .status(status)
    .type('html')
    .send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<link rel="stylesheet" href="/css/tailwind.css" />` +
        `<link rel="stylesheet" href="/css/app.css" /></head>` +
        `<body style="font-family:system-ui;padding:2rem"><h1>${title}</h1>` +
        `<pre>${safe}</pre></body></html>`
    );
}

app.use((req, res) => {
  // Avoid EJS render failures cascading into 502 for missing assets
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/vendor/')) {
    return res.status(404).type('text').send(`Not found: ${req.path}`);
  }
  try {
    return res.status(404).render('error', {
      title: 'Not Found',
      message: 'Page not found.',
      businessName: res.locals.businessName,
      admin: req.session?.adminUsername || null,
      flash: null,
    });
  } catch (err) {
    return sendErrorPage(res, 404, 'Not Found', 'Page not found.');
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  const message =
    process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message || String(err);
  try {
    return res.status(500).render('error', {
      title: 'Error',
      message,
      businessName: res.locals.businessName,
      admin: req.session?.adminUsername || null,
      flash: null,
    });
  } catch (_) {
    return sendErrorPage(res, 500, 'Error', message);
  }
});

whatsapp.attachSocket(io);

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Admin panel: http://${HOST}:${PORT}/admin/login`);
  console.log(`[Static] CSS URLs: /css/tailwind.css  /css/app.css`);

  // On Render free tier: let the HTTP service become healthy first, then start Chromium.
  // Inflating @sparticuz/chromium + WhatsApp Web can take 1–3 minutes and must not block boot.
  const delayMs = Number(process.env.WA_INIT_DELAY_MS) || (process.env.RENDER ? 3000 : 0);
  console.log(
    `[WhatsApp] Scheduling client init in ${delayMs}ms (puppeteer-core + @sparticuz/chromium)`
  );
  setTimeout(() => {
    whatsapp.init().catch((err) => {
      console.error('Failed to start WhatsApp client:', err);
    });
  }, delayMs);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[Process] unhandledRejection:', err);
});
