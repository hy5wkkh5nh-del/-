import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const revision = process.env.RENDER_GIT_COMMIT || 'local';
const build = JSON.parse(readFileSync(new URL('../dist/build-manifest.json', import.meta.url)));
const files = new Map();
function register(route, file, type, encoding) {
  files.set(route, { body: readFileSync(new URL('../dist/' + file, import.meta.url)), type, encoding });
}
register('/', 'index.html', 'text/html; charset=utf-8');
register('/review/p1/', 'review/p1/index.html', 'text/html; charset=utf-8');
for (const [name, type] of [['viewer.mjs', 'text/javascript; charset=utf-8'], ['review.css', 'text/css; charset=utf-8'], ['data.json', 'application/json; charset=utf-8']]) register('/review/p1/' + name, 'review/p1/' + name, type);
for (const name of ['source-assembly', 'vegetation-library']) register('/review/p1/assets/' + name + '.glb', 'review/p1/assets/' + name + '.glb.gz', 'model/gltf-binary', 'gzip');
for (const id of ['P033', 'P034', 'P035']) register('/review/p1/assets/' + id + '.jpg', 'review/p1/assets/' + id + '.jpg', 'image/jpeg');
for (const file of ['three.module.js', 'three.core.js', 'addons/controls/OrbitControls.js', 'addons/loaders/GLTFLoader.js', 'addons/utils/BufferGeometryUtils.js', 'addons/utils/SkeletonUtils.js']) register('/vendor/' + file, 'vendor/' + file, 'text/javascript; charset=utf-8');
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const json = (value) => Buffer.from(JSON.stringify(value));
export function createPublicServer() {
  return createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://public-site.invalid').pathname; }
    catch { res.writeHead(400); res.end(); return; }
    let status = 404, type = 'text/plain; charset=utf-8', body = Buffer.from('Not found'), encoding;
    if (pathname === '/api/health' && ['GET', 'HEAD'].includes(req.method)) {
      status = 200; type = 'application/json; charset=utf-8'; body = json({ ok: true, status: 'model-review', phase: 'P1', candidateOnly: true, revision });
    } else if (pathname === '/api' || pathname.startsWith('/api/')) {
      status = 410; type = 'application/json; charset=utf-8'; body = json({ error: 'PUBLIC_SITE_RESET', message: '旧版本接口已停用。' });
    } else if (!['GET', 'HEAD'].includes(req.method)) {
      status = 405; body = Buffer.from('Method not allowed');
    } else if (pathname === '/review/p1') {
      res.writeHead(308, { Location: '/review/p1/', 'Cache-Control': 'no-store' }); res.end(); return;
    } else if (files.has(pathname)) {
      ({ body, type, encoding } = files.get(pathname)); status = 200;
    }
    res.writeHead(status, {
      'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': csp,
      ...(encoding ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } : {}),
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {})
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createPublicServer();
  server.listen(Number(process.env.PORT || 10000), process.env.HOST || '0.0.0.0', async () => {
    try {
      const port = server.address().port;
      const checks = [['/', 200], ['/review/p1/', 200], ['/review/p1/viewer.mjs', 200], ['/vendor/addons/utils/SkeletonUtils.js', 200], ['/review/p1/assets/source-assembly.glb', 200], ['/review/p1/assets/vegetation-library.glb', 200], ['/api/health', 200], ['/api/bootstrap', 410], ['/api/assets', 410], ['/data/store.json', 404], ['/.env', 404], ['/assets/retired.glb', 404]];
      for (const [path, expected] of checks) {
        const response = await fetch('http://127.0.0.1:' + port + path, { method: 'HEAD' });
        if (response.status !== expected) throw new Error(path + ' returned ' + response.status);
      }
      console.log('[p1-review] READY ' + JSON.stringify({ phase: 'P1', revision, port, htmlSha256: createHash('sha256').update(files.get('/review/p1/').body).digest('hex'), ...build, checks: Object.fromEntries(checks) }));
    } catch (error) { console.error('[p1-review] Startup check failed: ' + error.message); process.exitCode = 1; server.close(); }
  });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  process.on('SIGTERM', () => server.close());
}

