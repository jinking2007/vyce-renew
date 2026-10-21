function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export function createLogger({ level = 'info' } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;

  const write = (name, stream, message) => {
    if (levels[name] < threshold) {
      return;
    }
    stream.write(`[${timestamp()}] [${name.toUpperCase()}] ${message}\n`);
  };

  return {
    debug: (message) => write('debug', process.stdout, message),
    info: (message) => write('info', process.stdout, message),
    warn: (message) => write('warn', process.stderr, message),
    error: (message) => write('error', process.stderr, message),
  };
}

export function describeError(error) {
  if (error instanceof Error) {
    const code = error.code ? ` (${error.code})` : '';
    const status = error.status ? ` HTTP ${error.status}` : '';
    return `${error.message}${code}${status}`;
  }
  return String(error);
}
