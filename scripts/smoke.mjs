const DEFAULT_BASE = 'http://localhost:3000';
const DEFAULT_RETRIES = 60;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

function integerSetting(name, fallback, { minimum = 1 } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function smokeConfig() {
  const base = (process.env.BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const retries = integerSetting('SMOKE_RETRIES', DEFAULT_RETRIES);
  const retryDelayMs = integerSetting('SMOKE_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS, { minimum: 0 });
  const requestTimeoutMs = integerSetting('SMOKE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
  return { base, retries, retryDelayMs, requestTimeoutMs };
}

class SmokeError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = 'SmokeError';
    this.fatal = fatal;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(base, path, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { signal: controller.signal });
    return { response, body: await response.text() };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new SmokeError(`${path}: request timed out after ${timeoutMs} ms`);
    }
    throw new SmokeError(`${path}: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function jsonBody(path, body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new SmokeError(`${path}: response was not valid JSON`);
  }
}

async function retryUntilReady(label, check, { retries, retryDelayMs }) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    attempts = attempt;
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (error?.fatal || attempt === retries) break;
      await sleep(retryDelayMs);
    }
  }

  throw new SmokeError(
    `${label} did not pass after ${attempts} attempt(s): ${lastError?.message ?? String(lastError)}`,
    { fatal: true },
  );
}

async function runSmoke({ base, retries, retryDelayMs, requestTimeoutMs } = smokeConfig()) {
  console.log(`==> healthz through same-origin proxy (${base})`);
  await retryUntilReady('healthz', async () => {
    const { response, body } = await request(base, '/api/v1/healthz', requestTimeoutMs);
    if (response.status !== 200) {
      throw new SmokeError(`/api/v1/healthz: expected 200, got ${response.status}`);
    }
    if (jsonBody('/api/v1/healthz', body).status !== 'ok') {
      throw new SmokeError('/api/v1/healthz: expected status=ok');
    }
  }, { retries, retryDelayMs });

  console.log('==> readyz is ready and semantic noop is not advertised');
  await retryUntilReady('readyz', async () => {
    const { response, body } = await request(base, '/api/v1/readyz', requestTimeoutMs);
    if (response.status !== 200) {
      throw new SmokeError(`/api/v1/readyz: expected 200, got ${response.status}`);
    }
    const ready = jsonBody('/api/v1/readyz', body);
    if (ready.status !== 'ready') {
      throw new SmokeError('/api/v1/readyz: expected status=ready');
    }
    if (ready.semantic_available !== false) {
      throw new SmokeError('/api/v1/readyz: expected semantic_available=false for noop', { fatal: true });
    }
  }, { retries, retryDelayMs });

  console.log('==> no duplicate root endpoint');
  const rootHealth = await request(base, '/healthz', requestTimeoutMs);
  if (rootHealth.response.status !== 404) {
    throw new SmokeError(`/healthz: expected 404, got ${rootHealth.response.status}`);
  }

  console.log('==> landing and app return 200');
  for (const path of ['/', '/vi', '/app']) {
    const result = await request(base, path, requestTimeoutMs);
    if (result.response.status !== 200) {
      throw new SmokeError(`${path}: expected 200, got ${result.response.status}`);
    }
  }

  console.log('==> HTML includes CSP');
  const landing = await request(base, '/', requestTimeoutMs);
  if (!landing.response.headers.get('content-security-policy')) {
    throw new SmokeError('/: missing Content-Security-Policy header');
  }

  console.log('OK — smoke pass');
}

try {
  await runSmoke();
} catch (error) {
  console.error(`SMOKE FAILED: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
