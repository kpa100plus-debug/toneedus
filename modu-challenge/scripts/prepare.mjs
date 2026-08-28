import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const dir = new URL("../bundle/", import.meta.url);
const names = (await readdir(dir)).filter((n) => /^part-\d+\.txt$/.test(n)).sort();
if (!names.length) throw new Error("Bundled source parts are missing");
let encoded = "";
for (const name of names) encoded += (await readFile(new URL(name, dir), "utf8")).trim();
const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
for (const [path, content] of Object.entries(bundle)) {
  const target = new URL(`../${path}`, import.meta.url);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, content, "utf8");
}
console.log(`Prepared ${Object.keys(bundle).length} MODU CHALLENGE runtime files.`);
