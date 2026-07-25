require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { Admins, Settings } = require('../models');

function seed() {
  if (Admins.count() === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    Admins.create({
      username,
      password_hash: bcrypt.hashSync(password, 10),
    });
    console.log(`Admin created: ${username}`);
  }

  const defaults = {
    business_name: 'WhatsApp Bot',
    welcome_message: 'Hello! 👋 Thanks for messaging us. How can we help you today?',
    default_reply: 'Thanks for your message. Our team will get back to you shortly.',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (Settings.get(key) === null) {
      Settings.set(key, value);
    }
  }

  console.log('Database seeded successfully.');
  console.log(`Database path: ${db.name}`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
