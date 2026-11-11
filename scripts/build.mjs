import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/index.html', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const html = await readFile(source, 'utf8');
if (!html.includes('data-edition="competition-next"')) {
  throw new Error('Public preparation page is missing its edition marker.');
}
await mkdir(output, { recursive: true });
await copyFile(source, new URL('index.html', output));
console.log('Public preparation page built: ' + fileURLToPath(output));
