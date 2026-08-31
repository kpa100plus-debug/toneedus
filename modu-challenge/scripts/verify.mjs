import { readFile } from 'node:fs/promises';

const files = {
  app: await readFile(new URL('../public/assets/live-app.js', import.meta.url), 'utf8'),
  client: await readFile(new URL('../public/assets/api-client.js', import.meta.url), 'utf8'),
  css: await readFile(new URL('../public/assets/styles.css', import.meta.url), 'utf8'),
  worker: await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8'),
  html: await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  migration: await readFile(new URL('../migrations/0002_admin_roles.sql', import.meta.url), 'utf8'),
  wrangler: await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
};

const checks = [
  ['공개 프로필 동작', files.app.includes("view-public-profile") && files.app.includes('openPublicProfile')],
  ['TRUST 상세 동작', files.app.includes("view-trust-history") && files.app.includes('openTrustHistory')],
  ['알림 읽음 API', files.worker.includes('/notifications\\/([^/]+)\\/read') && files.client.includes('markNotificationRead')],
  ['비밀번호 변경 보안', files.worker.includes('/api/auth/change-password') && files.worker.includes('otherSessionsSignedOut') && files.client.includes('changePassword') && files.app.includes('change-password-form') && files.app.includes('submitPasswordChange')],
  ['간편 챌린지 자동작성', files.app.includes('renderEasyCreateWizard') && files.app.includes('generateChallengeDraft') && files.app.includes('wizardPurpose') && files.css.includes('.create-mode-switch')],
  ['성공·증빙 체크형 작성', files.app.includes('renderCriteriaCheckBuilder') && files.app.includes('updateCriteriaFromChecks') && files.app.includes('successCheck') && files.app.includes('evidenceCheck') && files.css.includes('.criteria-option-grid')],
  ['보상금 용어 한글화', files.app.includes('보상금 준비 시점') && !files.app.includes('<label>Funding Trigger')],
  ['메인 LIVE 시각효과', files.app.includes('live-pill"><i>') && files.css.includes('@keyframes liveDotBlink') && files.css.includes('prefers-reduced-motion')],
  ['LIVE 보상금순 자동교체', files.app.includes('hydrateLiveChallengeRotation') && files.app.includes("sortChallenges(state.challenges.filter") && files.app.includes("'reward'") && files.app.includes('data-live-challenge') && files.app.includes('modu-live-rank-index') && !files.app.includes("board.matches(':hover')")],
  ['LIVE 카드 이동·입력 정렬', files.css.includes('heroBoardFloat 20s') && files.css.includes('calc(-100vw + 720px)') && files.css.includes('background: transparent') && files.css.includes('.hero-board:hover') && files.app.includes('reward-schedule-grid') && files.css.includes('.reward-schedule-grid')],
  ['관리자 운영 목록', files.worker.includes('pendingSettlements') && files.app.includes('admin-ops-grid')],
  ['최고관리자 회원 상세 조회', files.worker.includes('api\\/admin\\/members') && files.worker.includes('getAdminMemberDetail') && files.worker.includes('ADMIN_MEMBER_DETAIL_VIEW') && files.worker.includes('requirePrimaryAdmin(request, env)') && files.client.includes('adminMemberDetail') && files.app.includes('view-admin-member') && files.app.includes('openAdminMemberDetail')],
  ['확장 가입·인증·소셜 로그인', files.worker.includes('emailVerificationEnabled') && files.worker.includes('issueEmailVerification') && files.worker.includes('fetchOAuthProfile') && files.worker.includes('GOOGLE_OAUTH_CLIENT_ID') && files.worker.includes('NAVER_OAUTH_CLIENT_ID') && files.worker.includes('소셜 계정 이메일로 먼저 회원가입과 이메일 인증을 완료해주세요.') && files.client.includes('verifyEmail') && files.app.includes('challengeIntent') && files.app.includes('oauth-login')],
  ['필수 가입정보 검증', files.app.includes('confirmPassword') && files.app.includes('data-birth-year-digit') && files.app.includes('<option>전국</option>') && files.app.includes('value="female"') && files.app.includes('value="male"') && !files.app.includes('value="prefer_not"') && files.worker.includes("new Set(['female', 'male'])") && files.worker.includes('INVALID_BIRTH_YEAR') && files.worker.includes('INVALID_GENDER')],
  ['최고·부관리자 권한 분리', files.worker.includes('PRIMARY_ADMIN_EMAIL') && files.worker.includes('admin_roles') && files.worker.includes('requirePrimaryAdmin') && files.worker.includes('appointDeputy') && files.worker.includes("CREATE INDEX IF NOT EXISTS idx_admin_roles_role") && !files.worker.includes('await env.DB.exec(`') && files.client.includes('appointDeputy') && files.app.includes('renderDeputyAdmin') && files.migration.includes("admin_roles") && files.wrangler.includes('kpa100plus@gmail.com')],
  ['이용방법·신뢰안전 경로', files.app.includes("state.route === 'how'") && files.app.includes("state.route === 'trust'") && files.app.includes('function renderHow()') && files.app.includes('function renderTrustSafety()')],
  ['한글 폰트 우선순위', files.css.includes('"Malgun Gothic", "맑은 고딕"')],
  ['과도한 폰트 굵기 제거', !/font-weight:\s*(800|900)/.test(files.css)],
  ['대표자 표시', files.html.includes('모두의 챌린지 대표이사: 최인란')],
  ['공유 대표이미지', files.html.includes('property="og:image"') && files.html.includes('modu-share-preview.jpg') && files.html.includes('summary_large_image')],
  ['모바일 화면 잘림 방지', files.css.includes('overflow-x: clip') && files.css.includes('100dvh') && files.css.includes('body.modal-open')],
  ['모바일 입력 이탈 방지', files.app.includes('modalScrollY') && files.app.includes('field-counter') && files.app.includes('작성 기준')],
  ['모바일 모달 안전영역', files.css.includes('.modal-header, .modal-head') && files.css.includes('flex: 1 1 auto') && files.css.includes('env(safe-area-inset-bottom)')],
  ['초소형 화면 단일열', files.css.includes('.challenge-meta { grid-template-columns: minmax(0, 1fr); }') && files.css.includes('.profile-stat-grid, .trust-factor-grid { grid-template-columns: minmax(0, 1fr); }')],
  ['캐시 버전 일치', files.html.includes('styles.css?v=21') && files.html.includes('live-app.js?v=21') && (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')).includes("modu-challenge-v21")],
  ['웹앱 설치 안내', files.html.includes('app-install-banner') && files.app.includes('beforeinstallprompt') && files.app.includes('isIOSSafari')],
  ['CSS 괄호', (files.css.match(/{/g) || []).length === (files.css.match(/}/g) || []).length],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
