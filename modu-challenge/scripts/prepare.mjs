import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const EXPECTED_SHA256 = "c23aa0751e55e050a68081b1fafa2208c9e53ea694da3d3b863d108de0b125b0";
const EXPECTED_FILE_COUNT = 14;
const root = new URL("../", import.meta.url);
const dir = new URL("../bundle/", import.meta.url);
const names = (await readdir(dir)).filter((name) => /^part-\d+\.txt$/.test(name)).sort();

if (!names.length) throw new Error("Bundled source parts are missing");

let encoded = "";
for (const name of names) encoded += (await readFile(new URL(name, dir), "utf8")).trim();

const actualSha256 = createHash("sha256").update(encoded, "utf8").digest("hex");
if (actualSha256 !== EXPECTED_SHA256) {
  throw new Error(`Source bundle integrity check failed: ${actualSha256}`);
}

const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
const entries = Object.entries(bundle);
if (entries.length !== EXPECTED_FILE_COUNT) {
  throw new Error(`Unexpected runtime file count: ${entries.length}`);
}

for (const [path, content] of entries) {
  if (typeof path !== "string" || typeof content !== "string" || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new Error(`Unsafe bundled path: ${String(path)}`);
  }
  const target = new URL(path, root);
  if (!target.href.startsWith(root.href)) throw new Error(`Bundled path escaped project root: ${path}`);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, content, "utf8");
}

console.log(`Prepared ${entries.length} verified MODU CHALLENGE runtime files.`);
