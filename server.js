require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const { config } = require('./src/config/runtime');
const routes = require('./src/routes');
const whatsapp = require('./src/services/whatsapp');

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
app.use(express.json({ limit: '32kb' }));

if (!fs.existsSync(PUBLIC_DIR)) {
  console.error('[Static] Missing public directory:', PUBLIC_DIR);
} else {
  console.log('[Static] Serving', PUBLIC_DIR);
  for (const name of ['tailwind.css', 'app.css']) {
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

// Memory-only session store (default) — no session DB
app.use(
  session({
    name: 'wa.sid',
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
  res.locals.businessName = config.businessName;
  next();
});

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
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/')) {
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
  } catch (_) {
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

if (!config.companyPhone) {
  console.warn('[Config] Set COMPANY_PHONE in .env (digits with country code, e.g. 9198…)');
}
console.log(`[Config] BASE_URL=${config.baseUrl}`);
console.log(`[Config] COMPANY_PHONE=${config.companyPhone || '(missing)'}`);

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Admin: http://${HOST}:${PORT}/admin/login`);

  const delayMs = Number(process.env.WA_INIT_DELAY_MS) || (process.env.RENDER ? 3000 : 0);
  console.log(`[WhatsApp] Scheduling client init in ${delayMs}ms`);
  setTimeout(() => {
    whatsapp.init().catch((err) => {
      console.error('Failed to start WhatsApp client:', err);
    });
  }, delayMs);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[Process] unhandledRejection:', err);
});
