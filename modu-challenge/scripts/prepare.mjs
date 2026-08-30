import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const EXPECTED_SHA256 = "514e9b7f00d88690ea564ae2db2b21c728f08aaea841ba626fe79500be10e628";
const EXPECTED_FILE_COUNT = 15;
const BINARY_PATHS = new Set(["public/assets/modu-young-challengers.webp"]);
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
  if (BINARY_PATHS.has(path)) await writeFile(target, Buffer.from(content, "base64"));
  else await writeFile(target, content, "utf8");
}

const setupPage = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>최고관리자 안내 | 모두의 챌린지</title>
  <style>
    :root{font-family:Arial,"Noto Sans KR",sans-serif;color:#171a2b;background:#f4f5fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);background:#fff;border:1px solid #e5e7ef;border-radius:24px;padding:30px;box-shadow:0 20px 60px rgba(24,29,61,.12)}h1{margin:0 0 8px;font-size:28px;letter-spacing:-1px}p{color:#666d80;line-height:1.65}.badge{display:inline-block;background:#eeeaff;color:#6746e8;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;margin-bottom:16px}.btn{display:block;text-align:center;text-decoration:none;border-radius:13px;padding:14px;font-weight:900;background:linear-gradient(135deg,#6d4aff,#ff4f82);color:#fff;margin-top:20px}.notice{margin-top:16px;padding:14px;border-radius:12px;background:#eaf8f1;color:#10744e;line-height:1.6}.footer{margin-top:18px;font-size:12px;color:#7b8191}
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">ISEA GROUP · 운영 설정 완료</span>
    <h1>최고관리자 계정이 준비되었습니다</h1>
    <p>현재 Cloudflare D1에 최고관리자 계정이 별도로 설정되어 있습니다. 공개 표시명은 <strong>juyoungkim</strong>입니다.</p>
    <div class="notice"><strong>보안 안내</strong><br>관리자 로그인 정보와 활성 검증값은 공개 소스에 포함되지 않습니다.</div>
    <a class="btn" href="/">서비스 홈에서 로그인</a>
    <div class="footer">© 2026 ISEA GROUP. All Rights Reserved.</div>
  </main>
</body>
</html>
`;
await writeFile(new URL("../public/setup-admin.html", import.meta.url), setupPage, "utf8");

console.log(`Prepared ${entries.length} verified MODU CHALLENGE runtime files. Administrator credentials are never bundled in public source.`);
