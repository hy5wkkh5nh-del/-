import { copyFile, mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/index.html', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const html = await readFile(source, 'utf8');
if (!html.includes('data-edition="competition-next"')) {
  throw new Error('Public preparation page is missing its edition marker.');
}
await mkdir(output, { recursive: true });
await cp(new URL('../public/', import.meta.url), output, { recursive: true });
const vendors = {
  'three.module.js': 'build/three.module.js',
  'three.core.js': 'build/three.core.js',
  'addons/controls/OrbitControls.js': 'examples/jsm/controls/OrbitControls.js',
  'addons/loaders/GLTFLoader.js': 'examples/jsm/loaders/GLTFLoader.js',
  'addons/utils/BufferGeometryUtils.js': 'examples/jsm/utils/BufferGeometryUtils.js',
  'addons/utils/SkeletonUtils.js': 'examples/jsm/utils/SkeletonUtils.js'
};
for (const [target, origin] of Object.entries(vendors)) {
  const destination = new URL('vendor/' + target, output);
  await mkdir(new URL('./', destination), { recursive: true });
  await copyFile(new URL('../node_modules/three/' + origin, import.meta.url), destination);
}
const assets = {};
for (const name of ['source-assembly', 'vegetation-library']) {
  const file = await readFile(new URL('review/p1/assets/' + name + '.glb.gz', output));
  assets[name] = { compressedBytes: file.length, sha256: createHash('sha256').update(file).digest('hex') };
}
await writeFile(new URL('build-manifest.json', output), JSON.stringify({ phase: 'P1', candidateOnly: true, assets }));
console.log('P1 review built: ' + fileURLToPath(output));
