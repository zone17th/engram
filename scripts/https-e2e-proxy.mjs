import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';

const CERT_FILE = process.env.TLS_CERT_FILE;
const KEY_FILE = process.env.TLS_KEY_FILE;
if (!CERT_FILE || !KEY_FILE) {
  throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must point to local test certificate files');
}
const HOST = process.env.TLS_PROXY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TLS_PROXY_PORT ?? 13443);
const WEB_UPSTREAM = new URL(process.env.HTTPS_TEST_WEB_UPSTREAM ?? 'http://127.0.0.1:13000');
const API_UPSTREAM = new URL(process.env.HTTPS_TEST_API_UPSTREAM ?? 'http://127.0.0.1:18081');

function assertLoopbackHttp(url, name) {
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`${name} must be an http loopback URL`);
  }
}

assertLoopbackHttp(WEB_UPSTREAM, 'HTTPS_TEST_WEB_UPSTREAM');
assertLoopbackHttp(API_UPSTREAM, 'HTTPS_TEST_API_UPSTREAM');

function isApiPath(requestUrl) {
  const pathname = new URL(requestUrl ?? '/', `https://${HOST}:${PORT}`).pathname;
  return pathname === '/api' || pathname.startsWith('/api/');
}

function upstreamFor(requestUrl) {
  return isApiPath(requestUrl) ? API_UPSTREAM : WEB_UPSTREAM;
}

function proxyRequest(request, response) {
  const upstream = upstreamFor(request.url);
  const headers = {
    ...request.headers,
    host: upstream.host,
    'x-forwarded-host': request.headers.host ?? `${HOST}:${PORT}`,
    'x-forwarded-port': String(PORT),
    'x-forwarded-proto': 'https',
  };
  const client = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url || '/',
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  client.setTimeout(10_000, () => client.destroy());

  client.once('error', (error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('upstream unavailable');
    console.error(`tls-proxy upstream ${upstream.port} error: ${error.code ?? 'unknown'}`);
  });
  request.once('aborted', () => client.destroy());
  request.pipe(client);
}

const server = https.createServer(
  {
    cert: readFileSync(resolve(CERT_FILE)),
    key: readFileSync(resolve(KEY_FILE)),
  },
  proxyRequest,
);

server.once('error', (error) => {
  console.error(`tls-proxy server error: ${error.code ?? 'unknown'}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`tls-proxy listening on ${HOST}:${PORT}`);
});
