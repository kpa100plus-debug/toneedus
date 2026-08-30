import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';

const runtimePaths = [
  'migrations/0001_init.sql',
  'public/_headers',
  'public/assets/api-client.js',
  'public/assets/business-rules.js',
  'public/assets/data.js',
  'public/assets/live-app.js',
  'public/assets/logo.svg',
  'public/assets/modu-share-preview.jpg',
  'public/assets/modu-young-challengers.webp',
  'public/assets/styles.css',
  'public/index.html',
  'public/manifest.webmanifest',
  'public/robots.txt',
  'public/setup-admin.html',
  'public/sw.js',
  'worker/index.mjs',
];

const root = new URL('../', import.meta.url);
const bundleDir = new URL('../bundle/', import.meta.url);
const prepareUrl = new URL('./prepare.mjs', import.meta.url);
const bundle = {};

const binaryPaths = new Set(['public/assets/modu-share-preview.jpg', 'public/assets/modu-young-challengers.webp']);
for (const path of runtimePaths) {
  const content = await readFile(new URL(path, root));
  bundle[path] = binaryPaths.has(path) ? content.toString('base64') : content.toString('utf8');
}

const encoded = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 }).toString('base64');
const sha256 = createHash('sha256').update(encoded, 'utf8').digest('hex');
const chunkSize = 8_238;
const chunks = [];
for (let offset = 0; offset < encoded.length; offset += chunkSize) chunks.push(encoded.slice(offset, offset + chunkSize));

const oldParts = (await readdir(bundleDir)).filter((name) => /^part-\d+\.txt$/.test(name));
for (const name of oldParts) await unlink(new URL(name, bundleDir));
for (const [index, chunk] of chunks.entries()) {
  const name = `part-${String(index + 1).padStart(3, '0')}.txt`;
  await writeFile(new URL(name, bundleDir), `${chunk}\n`, 'utf8');
}

const prepareSource = await readFile(prepareUrl, 'utf8');
if (!/const EXPECTED_SHA256 = "[a-f0-9]{64}";/.test(prepareSource)) {
  throw new Error('Could not locate the bundle integrity hash');
}
const updatedPrepareSource = prepareSource.replace(
  /const EXPECTED_SHA256 = "[a-f0-9]{64}";/,
  `const EXPECTED_SHA256 = "${sha256}";`,
);
if (updatedPrepareSource !== prepareSource) await writeFile(prepareUrl, updatedPrepareSource, 'utf8');

console.log(`Packed ${runtimePaths.length} runtime files into ${chunks.length} verified source parts (${sha256}).`);
