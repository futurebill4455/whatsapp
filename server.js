require('dotenv').config();

const path = require('path');
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  res.locals.businessName = require('./src/models').Settings.get('business_name', 'Insurance Bot');
  next();
});

app.use(routes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found',
    message: 'Page not found.',
    businessName: res.locals.businessName,
    admin: req.session?.adminUsername || null,
    flash: null,
  });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
    businessName: res.locals.businessName,
    admin: req.session?.adminUsername || null,
    flash: null,
  });
});

whatsapp.attachSocket(io);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
  whatsapp.init().catch((err) => {
    console.error('Failed to start WhatsApp client:', err);
  });
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  process.exit(0);
});
