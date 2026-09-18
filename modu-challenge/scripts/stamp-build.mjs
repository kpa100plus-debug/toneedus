import { readFile, writeFile } from 'node:fs/promises';
const url = new URL('../wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(url, 'utf8'));
if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('Deployment requires the source commit SHA');
config.vars.COMMIT_SHA = process.env.GITHUB_SHA;
config.vars.DEPLOYED_AT = new Date().toISOString();
await writeFile(url, JSON.stringify(config, null, 2) + '\n');
