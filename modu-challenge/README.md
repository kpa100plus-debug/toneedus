# 모두의 챌린지 · MODU CHALLENGE V0.5.4

범용 성과형 챌린지 마켓플레이스의 Cloudflare 운영형 스테이징입니다.

## 현재 Cloudflare 배포

- 서비스: https://modu-challenge.yeit.workers.dev
- 관리자 페이지: https://modu-challenge.yeit.workers.dev/#/admin
- API 상태: https://modu-challenge.yeit.workers.dev/api/health
- Worker: `modu-challenge`
- D1: `modu-challenge-db`
- 예약 작업: 매시 정각 (`0 * * * *`)

`yeit.workers.dev`는 Cloudflare 계정의 스테이징 서브도메인입니다. 정식 공개용 맞춤 도메인은 별도로 연결할 수 있습니다.

## 메인 임팩트 카운터

- 공개 챌린지·TEASER·참여 신호·보상금·성공 상태를 현재 API 데이터에서 자동 집계합니다.
- 성공자 예상 순보상은 표시 보상금에서 기본 플랫폼 수수료 10%를 차감해 계산합니다.
- 시간·탐색비용 절감은 미리보기용 추정치이며, TEASER 1건당 사전 탐색 2시간과 시간가치 2만원을 적용합니다.
- 예시 데이터 기반 수치는 실제 운영 실적이나 실제 지급액으로 표시하지 않습니다.

## 확정 기준

- 공개 관리자·프로필 표시명: `juyoungkim`
- 운영·권리 주체: ㈜ISEA GROUP
- 기본 플랫폼 이용수수료: 보상금의 10%
- 정산 기준: 표시 보상금 100% 중 플랫폼 10%, 성공 참가자 90%
- 거래 흐름: POST → TEASER → SHORTLIST/FINALIST → FUND → EXECUTE → PROOF → SUCCESS → PAYOUT → REVIEW/TRUST
- 실제 돈 기능: PG·지급대행 계약과 검증된 Webhook 연결 전까지 서버와 화면에서 비활성화

## 소스 준비와 재배포

```bash
npm install
npm run prepare:source
npm run deploy
```

`prepare:source`는 분할 번들의 SHA-256과 14개 런타임 파일을 검증한 뒤 배포 파일을 복원합니다. 현재 원격 D1의 관리자 계정은 재배포해도 유지되며, 공개 소스가 관리자 계정을 새로 만들거나 덮어쓰지 않습니다.

## 로그인 보안

- 비밀번호는 브라우저에서 PBKDF2-SHA256 210,000회로 처리됩니다.
- 서버는 32바이트 로그인 검증자를 다시 SHA-256 해시하여 D1에 저장합니다.
- 관리자 비밀번호, 활성 관리자 검증자 해시, 활성 Salt는 GitHub에 포함되지 않습니다.
- 현재 최고관리자 계정은 원격 D1에 별도로 프로비저닝되어 있습니다.
- 세션은 HttpOnly·SameSite 쿠키로 관리합니다.

## 운영상 주의

- 기본환경은 `APP_ENV=staging`, `PUBLIC_MONEY_ENABLED=false`입니다.
- 회원가입·로그인·챌린지 등록·TEASER·SHORTLIST는 실제 D1 데이터로 사용할 수 있습니다.
- Funding·실결제·지급·10% 자동정산은 PG 및 지급대행 연결, Webhook 서명검증, 법률·세무 검토 후 별도 활성화해야 합니다.
- 이용약관·개인정보처리방침·카테고리별 자격 및 금지행위 정책은 정식 공개 전에 최종 검토가 필요합니다.

© 2026 ISEA GROUP. All Rights Reserved.
