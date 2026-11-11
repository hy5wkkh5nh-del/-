import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const html = readFileSync(new URL('../dist/index.html', import.meta.url));
const revision = process.env.RENDER_GIT_COMMIT || 'local';
const json = (value) => Buffer.from(JSON.stringify(value));

export function createPublicServer() {
  return createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://public-site.invalid').pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let status = 404;
    let type = 'text/plain; charset=utf-8';
    let body = Buffer.from('Not found');
    if (pathname === '/api/health' && ['GET', 'HEAD'].includes(req.method)) {
      status = 200;
      type = 'application/json; charset=utf-8';
      body = json({ ok: true, status: 'preparing', edition: 'competition-next', revision });
    } else if (pathname === '/api' || pathname.startsWith('/api/')) {
      status = 410;
      type = 'application/json; charset=utf-8';
      body = json({ error: 'PUBLIC_SITE_RESET', message: '公用网站已重置，旧版本接口已停用。' });
    } else if (pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
      status = 200;
      type = 'text/html; charset=utf-8';
      body = html;
    } else if (!['GET', 'HEAD'].includes(req.method)) {
      status = 405;
      body = Buffer.from('Method not allowed');
    }
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {})
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 10000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createPublicServer();
  server.listen(port, host, async () => {
    try {
      const address = server.address();
      const checks = [['/', 200], ['/api/health', 200], ['/api/bootstrap', 410], ['/api/assets', 410], ['/data/store.json', 404], ['/assets/retired.glb', 404]];
      for (const [pathname, expected] of checks) {
        const response = await fetch('http://127.0.0.1:' + address.port + pathname);
        await response.arrayBuffer();
        if (response.status !== expected) throw new Error(pathname + ' returned ' + response.status);
      }
      console.log('[public-reset] READY ' + JSON.stringify({
        edition: 'competition-next',
        revision,
        port: address.port,
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        checks: Object.fromEntries(checks)
      }));
    } catch (error) {
      console.error('[public-reset] Startup check failed: ' + error.message);
      process.exitCode = 1;
      server.close();
    }
  });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  process.on('SIGTERM', () => server.close());
}
