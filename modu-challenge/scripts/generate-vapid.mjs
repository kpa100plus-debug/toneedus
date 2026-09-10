import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const output = process.argv[2] || '.vapid.json';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateJwk = privateKey.export({ format: 'jwk' });
const publicJwk = publicKey.export({ format: 'jwk' });

const key = (value) => Buffer.from(value, 'base64url');
const publicBytes = Buffer.concat([Buffer.from([4]), key(publicJwk.x), key(publicJwk.y)]);
await writeFile(output, JSON.stringify({
  publicKey: publicBytes.toString('base64url'),
  privateKey: privateJwk.d,
}), { mode: 0o600 });
