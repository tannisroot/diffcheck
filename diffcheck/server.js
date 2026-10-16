// Minimal static server. No framework, one dependency (diff, served to the browser).
// Every asset is read into memory at startup and served from a fixed allowlist,
// so there is no filesystem access per request and no path traversal surface.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 for Docker / LAN
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Invalid PORT');
}

function diffBundle() {
  const dist = join(dirname(require.resolve('diff/package.json')), 'dist');
  for (const name of ['diff.min.js', 'diff.js']) {
    try {
      return readFileSync(join(dist, name));
    } catch { /* try next */ }
  }
  throw new Error('Browser bundle of "diff" not found. Run: npm install');
}

const pub = (name) => readFileSync(join(here, 'public', name));
const asset = (body, type) => ({
  body,
  type,
  etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
});

const ASSETS = new Map([
  ['/', asset(pub('index.html'), 'text/html; charset=utf-8')],
  ['/style.css', asset(pub('style.css'), 'text/css; charset=utf-8')],
  ['/theme.js', asset(pub('theme.js'), 'text/javascript; charset=utf-8')],
  ['/app.js', asset(pub('app.js'), 'text/javascript; charset=utf-8')],
  ['/favicon.svg', asset(pub('favicon.svg'), 'image/svg+xml')],
  ['/vendor/diff.js', asset(diffBundle(), 'text/javascript; charset=utf-8')],
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cache-Control': 'no-cache',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
  }

  const a = ASSETS.get(pathname);
  if (!a) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
  }

  const headers = { 'Content-Type': a.type, ETag: a.etag };
  if (req.headers['if-none-match'] === a.etag) {
    return send(res, 304, headers);
  }
  headers['Content-Length'] = a.body.length;
  send(res, 200, headers, req.method === 'HEAD' ? undefined : a.body);
});

server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => {
  console.log(`diffcheck listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
