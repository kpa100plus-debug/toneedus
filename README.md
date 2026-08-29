# 모두의 챌린지 · MODU CHALLENGE V0.5.2

범용 성과형 챌린지 마켓플레이스 운영형 스테이징입니다.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kpa100plus-debug/toneedus/tree/modu-challenge-app/modu-challenge)

## 확정 기준

- 공개 관리자·프로필 표시명: `juyoungkim`
- 운영·권리 주체: ㈜ISEA GROUP
- 기본 플랫폼 이용수수료: 보상금의 10%
- 정산 기준: 표시 보상금 100% 중 플랫폼 10%, 성공 참가자 90%
- 거래 흐름: POST → TEASER → SHORTLIST/FINALIST → FUND → EXECUTE → PROOF → SUCCESS → PAYOUT → REVIEW/TRUST
- 실제 돈 기능: PG·지급대행 계약과 검증된 Webhook 연결 전까지 서버와 화면에서 비활성화

## 최종 원클릭 배포

위 **Deploy to Cloudflare** 버튼을 누르면 Cloudflare가 이 하위 디렉터리를 독립 프로젝트 루트로 복제하고 다음 작업을 진행합니다.

1. 새 GitHub 저장소 생성
2. Cloudflare Worker와 정적 자산 구성
3. D1 데이터베이스 자동 생성·바인딩
4. D1 마이그레이션 실행
5. 최고관리자 계정 자동 생성
6. Worker 배포
7. 이후 Git Push 기반 자동배포 연결

배포 화면에서는 저장소명과 Worker 이름을 `modu-challenge`로 유지하고 **Deploy 승인만 진행**하면 됩니다. 별도의 Secret 입력이나 최고관리자 초기화 작업은 없습니다.

## 최고관리자

D1 첫 마이그레이션에서 최고관리자 계정이 자동 생성됩니다.

- 로그인 이메일·비밀번호: 별도로 제공된 `MODU_CHALLENGE_ADMIN_LOGIN.txt` 확인
- 공개 표시명: `juyoungkim`
- 관리자 비밀번호 평문은 GitHub 저장소에 포함되지 않음
- D1에는 PBKDF2-SHA256 해시와 Salt만 저장

배포 후 서비스 홈의 로그인 창에서 바로 로그인합니다.

## 운영상 주의

- 현재 기본환경은 `APP_ENV=staging`, `PUBLIC_MONEY_ENABLED=false`입니다.
- 회원가입·로그인·챌린지 등록·TEASER·SHORTLIST는 실제 D1 데이터로 사용할 수 있습니다.
- 실제 Funding·결제·지급·10% 정산은 PG 및 지급대행 연결과 법률·세무 검토 후 별도 활성화합니다.
- 이용약관·개인정보처리방침·카테고리별 자격 및 금지행위 정책은 정식 공개 전에 최종 검토가 필요합니다.

© 2026 ISEA GROUP. All Rights Reserved.
