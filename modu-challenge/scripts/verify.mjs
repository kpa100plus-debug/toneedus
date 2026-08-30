import { readFile } from 'node:fs/promises';

const files = {
  app: await readFile(new URL('../public/assets/live-app.js', import.meta.url), 'utf8'),
  client: await readFile(new URL('../public/assets/api-client.js', import.meta.url), 'utf8'),
  css: await readFile(new URL('../public/assets/styles.css', import.meta.url), 'utf8'),
  worker: await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8'),
  html: await readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
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
  ['한글 폰트 우선순위', files.css.includes('"Malgun Gothic", "맑은 고딕"')],
  ['과도한 폰트 굵기 제거', !/font-weight:\s*(800|900)/.test(files.css)],
  ['대표자 표시', files.html.includes('모두의 챌린지 대표이사: 최인란')],
  ['CSS 괄호', (files.css.match(/{/g) || []).length === (files.css.match(/}/g) || []).length],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
