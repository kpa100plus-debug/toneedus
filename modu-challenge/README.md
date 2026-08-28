# 모두의 챌린지 · MODU CHALLENGE

범용 성과형 챌린지 마켓플레이스 운영형 스테이징입니다.

- 공개 표시명: `juyoungkim`
- 운영·권리 주체: ㈜ISEA GROUP
- 기본 플랫폼 이용수수료: 보상금의 10%
- 돈의 흐름: PG·지급대행 계약 전까지 서버와 화면에서 비활성화

## Cloudflare 원클릭 배포

Cloudflare Deploy 버튼에서 Worker 이름은 `modu-challenge`로 유지하고, D1과 세 비밀값을 생성합니다. 배포 스크립트가 번들 소스를 복원한 후 D1 마이그레이션과 Worker 배포를 실행합니다.

배포 후 `/setup-admin.html`에서 최초 최고관리자를 생성합니다. 공개 표시명은 자동으로 `juyoungkim`입니다.

## 보안 비밀값

- `ADMIN_BOOTSTRAP_TOKEN`
- `PAYMENT_WEBHOOK_SECRET`
- `PAYOUT_WEBHOOK_SECRET`

비밀값은 저장소에 커밋하지 않습니다.

© 2026 ISEA GROUP. All Rights Reserved.
