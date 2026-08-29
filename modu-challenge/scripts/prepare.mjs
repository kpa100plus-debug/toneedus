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

const migrationPath = new URL("../migrations/0001_init.sql", import.meta.url);
const originalMigration = await readFile(migrationPath, "utf8");
const migrationMarker = ");\n\nCREATE TABLE IF NOT EXISTS sessions";
const seededMigration = `);

INSERT OR IGNORE INTO users (
  id, email, password_hash, password_salt, display_name, account_type,
  status, is_admin, identity_verified, business_verified, professional_verified,
  email_verified, terms_version, terms_accepted_at, privacy_version,
  privacy_accepted_at, trust_score, strike_count, bounty_limit
) VALUES (
  'usr_admin_juyoungkim',
  'admin@moduchallenge.local',
  'WM5iabbmx89ynjTjvUsXLCG7ZeLpzlbBIl1xb2Tdn2Y=',
  'tF0wMi5SGAhk5QzX7rlLpQ==',
  'juyoungkim',
  'corporation',
  'active',
  1, 1, 1, 0, 1,
  '2026-08-29-v1', CURRENT_TIMESTAMP,
  '2026-08-29-v1', CURRENT_TIMESTAMP,
  100, 0, 1000000000
);

CREATE TABLE IF NOT EXISTS sessions`;
if (!originalMigration.includes(migrationMarker)) throw new Error("D1 administrator seed marker is missing");
await writeFile(migrationPath, originalMigration.replace(migrationMarker, seededMigration), "utf8");

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
    <span class="badge">ISEA GROUP · 자동 설정 완료</span>
    <h1>최고관리자 계정이 준비되었습니다</h1>
    <p>배포 시 최고관리자 계정이 자동 생성됩니다. 공개 표시명은 <strong>juyoungkim</strong>으로 고정됩니다.</p>
    <div class="notice"><strong>로그인 정보</strong><br>별도로 제공된 관리자 로그인 정보 파일을 확인하세요.</div>
    <a class="btn" href="/">서비스 홈에서 로그인</a>
    <div class="footer">© 2026 ISEA GROUP. All Rights Reserved.</div>
  </main>
</body>
</html>
`;
await writeFile(new URL("../public/setup-admin.html", import.meta.url), setupPage, "utf8");

console.log(`Prepared ${entries.length} verified MODU CHALLENGE runtime files with automatic administrator provisioning.`);
