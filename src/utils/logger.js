/**
 * Lightweight leveled logger — keeps PM2 / event-loop free of verbose spam.
 *
 * LOG_LEVEL=error|warn|info|debug  (default: info)
 * WA_DEBUG=1 is an alias for debug.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel() {
  if (process.env.WA_DEBUG === '1' || process.env.DEBUG === '1') return LEVELS.debug;
  const name = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[name] != null ? LEVELS[name] : LEVELS.info;
}

let current = resolveLevel();

function log(levelName, args) {
  const n = LEVELS[levelName];
  if (n == null || n > current) return;
  const out =
    levelName === 'error'
      ? console.error
      : levelName === 'warn'
        ? console.warn
        : console.log;
  out(...args);
}

const logger = {
  error: (...args) => log('error', args),
  warn: (...args) => log('warn', args),
  info: (...args) => log('info', args),
  debug: (...args) => log('debug', args),
  isDebug: () => current >= LEVELS.debug,
  refresh() {
    current = resolveLevel();
  },
};

module.exports = logger;
