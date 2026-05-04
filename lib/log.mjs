export const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

const LEVEL_NAME = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const LEVEL = LOG_LEVELS[LEVEL_NAME] ?? LOG_LEVELS.info;

export const logLevelName = LEVEL_NAME;
export const logLevel = LEVEL;
export const logLevelIsKnown = LEVEL_NAME in LOG_LEVELS;

const ts = () => new Date().toISOString();

export const log = {
  error: (msg) => { if (LEVEL >= LOG_LEVELS.error) console.error(`[${ts()}] ERROR ${msg}`); },
  info:  (msg) => { if (LEVEL >= LOG_LEVELS.info)  console.log(`[${ts()}] INFO  ${msg}`); },
  debug: (msg) => { if (LEVEL >= LOG_LEVELS.debug) console.log(`[${ts()}] DEBUG ${msg}`); },
};

export const passthroughChild = LEVEL >= LOG_LEVELS.debug;
