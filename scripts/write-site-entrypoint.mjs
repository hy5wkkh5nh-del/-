import { mkdir, copyFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dist = 'dist';
const assetFiles = ['index.html', 'favicon.svg', 'project-bootstrap.json'];
const assetsDir = path.join(dist, 'assets');
for (const name of await readdir(assetsDir)) {
  if (/\.(js|css)$/.test(name)) assetFiles.push(path.join('assets', name));
}
const entries = [];
for (const rel of assetFiles) {
  const abs = path.join(dist, rel);
  const body = await readFile(abs, 'utf8');
  entries.push([`/${rel.replaceAll('\\\\', '/')}`, body]);
}
const source = `const ASSETS = ${JSON.stringify(Object.fromEntries(entries))};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function mime(path) { const ext = path.slice(path.lastIndexOf('.')); return TYPES[ext] || 'text/plain; charset=utf-8'; }
export default { fetch(request) { const url = new URL(request.url); const key = url.pathname === '/' ? '/index.html' : url.pathname; const body = ASSETS[key] ?? (url.pathname.startsWith('/assets/') ? null : ASSETS['/index.html']); if (body == null) return new Response('Not found', { status: 404 }); return new Response(body, { headers: { 'content-type': mime(key), 'cache-control': 'no-cache' } }); } };
`;
await mkdir(path.join(dist, 'server'), { recursive: true });
await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(dist, 'server', 'index.js'), source, 'utf8'));

