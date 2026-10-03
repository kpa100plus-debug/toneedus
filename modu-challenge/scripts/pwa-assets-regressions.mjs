import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('public/manifest.webmanifest',root),'utf8'));
assert.equal(manifest.display,'standalone');assert.equal(manifest.id,'/');
for(const size of [192,512])assert.ok(manifest.icons.some(i=>i.sizes===`${size}x${size}`&&i.type==='image/png'&&i.purpose==='any'));
assert.ok(manifest.icons.some(i=>i.purpose==='maskable'&&i.sizes==='512x512'));
for(const icon of [...manifest.icons,{src:'/assets/icon-180.png',sizes:'180x180'}]){
 const bytes=readFileSync(new URL('public'+icon.src,root));const [width,height]=icon.sizes.split('x').map(Number);
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),width);assert.equal(bytes.readUInt32BE(20),height);
 assert.ok(readFileSync(new URL('public/sw.js',root),'utf8').includes(icon.src));
}
assert.match(readFileSync(new URL('public/index.html',root),'utf8'),/rel="apple-touch-icon" sizes="180x180" href="\/assets\/icon-180.png"/);
console.log('PASS PWA assets: restored PNG bytes, manifest dimensions, Apple icon and cache references');
