# 모두의 챌린지 · MODU CHALLENGE

범용 성과형 챌린지 마켓플레이스 운영형 스테이징입니다.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kpa100plus-debug/toneedus/tree/modu-challenge-app/modu-challenge)

## 확정 기준

- 공개 관리자·프로필 표시명: `juyoungkim`
- 운영·권리 주체: ㈜ISEA GROUP
- 기본 플랫폼 이용수수료: 보상금의 10%
- 정산 기준: 표시 보상금 100% 중 플랫폼 10%, 성공 참가자 90%
- 거래 흐름: POST → TEASER → SHORTLIST/FINALIST → FUND → EXECUTE → PROOF → SUCCESS → PAYOUT → REVIEW/TRUST
- 실제 돈 기능: PG·지급대행 계약과 검증된 Webhook 연결 전까지 서버와 화면에서 비활성화

## 원클릭 배포

위 **Deploy to Cloudflare** 버튼을 누르면 Cloudflare가 이 하위 디렉터리를 독립 프로젝트 루트로 복제하고 다음 작업을 진행합니다.

1. 새 GitHub 저장소 생성
2. Cloudflare Worker와 정적 자산 구성
3. D1 데이터베이스 자동 생성·바인딩
4. D1 마이그레이션 실행
5. Worker 배포
6. 이후 Git Push 기반 자동배포 연결

배포 화면에서 Worker 이름은 `modu-challenge`를 우선 사용하고, 다음 비밀값 세 개를 각각 32자 이상의 임의 문자열로 입력합니다.

- `ADMIN_BOOTSTRAP_TOKEN`
- `PAYMENT_WEBHOOK_SECRET`
- `PAYOUT_WEBHOOK_SECRET`

비밀값은 저장소에 커밋하지 않습니다.

## 최초 최고관리자 생성

배포가 완료되면 아래 주소를 엽니다.

```text
https://<배포된-worker주소>/setup-admin.html
```

입력 항목:

- 최고관리자 이메일
- 관리자 비밀번호
- `ADMIN_BOOTSTRAP_TOKEN`

공개 표시명은 자동으로 `juyoungkim`으로 생성됩니다.

## 운영상 주의

- 현재 기본환경은 `APP_ENV=staging`, `PUBLIC_MONEY_ENABLED=false`입니다.
- 실제 Funding·결제·지급·10% 정산은 PG 및 지급대행 연결과 법률·세무 검토 후 별도 활성화합니다.
- 이용약관·개인정보처리방침·카테고리별 자격 및 금지행위 정책은 정식 공개 전에 최종 검토가 필요합니다.

© 2026 ISEA GROUP. All Rights Reserved.
