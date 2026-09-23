import { readFile, writeFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const config=JSON.parse(await readFile(new URL('wrangler.jsonc',root),'utf8'));
const version=config.vars.PWA_VERSION;
if(!/^v[1-9][0-9]*$/.test(version)) throw Error('Invalid PWA version');
for(const file of ['public/index.html','public/sw.js','public/manifest.webmanifest','public/assets/live-app.js','scripts/verify.mjs']) {
  const path=new URL(file,root),before=await readFile(path,'utf8');
  const after=before.replace(/\?v=\d+/g,`?${version.replace('v','v=')}`).replace(/modu-challenge-v\d+/g,`modu-challenge-${version}`);
  await writeFile(path,after);
}
console.log(`PWA URLs, cache and checks synchronized to ${version}`);
