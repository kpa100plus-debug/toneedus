# v62 — 인증 복귀 및 카드 간격 복구

- 요청: REF-MODUCLEAR-RESUME-RECOVERY-FULL-EXECUTION-20260925-01
- 제작일: 2026-09-25 (KST)
- 운영 주체: (주)ISEA GROUP
- 기준: 0.13.4 / v61 / 0bcfad6e5144b2c8f66da0ebdf800d914dec1bcc
- 변경 버전: 0.13.5 / v62

## 변경 이유와 결과

운영 화면에서 작성자와 보상금 영역의 간격이 0/4/31px로 달랐다. 카드 높이를 채우는 자동 여백을 설명 영역으로 옮기고 작성자 아래 간격을 20px로 고정했다. 긴 활동명은 말줄임하며 프로필 조회는 유지한다.

인증기관 미연결 상태를 미션 등록·수행 신청 작성 전에 안내한다. 인증 관리에서 취소하거나 돌아와도 기존 작성 내용을 복구한다. 인증 결과를 재조회할 수 있으며, 재조회·리디렉션 완료 후 서버에서 현재 회원 정보를 새로 읽는다. 임시 복귀 정보와 수행 신청 초안은 회원별로 분리한다. 인증 완료는 클라이언트나 관리자가 임의로 만들 수 없다.

KCP의 본인인증 ID 규격(영문·숫자, 40자 이하)에 맞게 신규 요청 ID를 변경했다. 기존 요청과 DB 스키마는 보존한다. SDK 로딩은 15초 후 오류를 안내하고 재시도를 허용한다. 로딩 실패는 서버 인증 요청 횟수를 소모하지 않는다.

관리자 → 인증 요청 심사·재확인에서 아래 설정의 유무만 표시한다. 실제 값은 표시하거나 기록하지 않는다.

- IDENTITY_VERIFICATION_PROVIDER = portone-v2
- IDENTITY_INTEGRATION_APPROVED = true (실제 계약·검증 완료 후에만 설정)
- PORTONE_STORE_ID
- PORTONE_IDENTITY_CHANNEL_KEY
- PORTONE_API_SECRET
- IDENTITY_HASH_SECRET (최소 32자)

설정만으로 기관 계약·심사가 완료되는 것은 아니다. 기관 계약, 채널 연결, 허용 도메인과 콜백 설정, 실제 사용자 동의를 통한 인증 검증이 필요하다. 운영에서 미인증 미션 등록·수행 신청과 실제 결제·지급 차단은 유지한다.

## 검증

- 기존 npm test: 통과 (메모리 SQLite, 모의 API/DOM)
- 새 인증 복구 회귀 10개 그룹: 통과
- 미인증 차단, 기관 결과 대조, 회원별 귀속, 중복 본인 식별, 만료·기관 오류, 의뢰·수행 권한 검증: 기존 launch 회귀로 검증
- PC·모바일 실운영 렌더링과 최종 배포 정보: 배포 후 대화 결과에 기록
- 인증기관의 실제 SMS/앱 인증과 실제 청구·송금: 실행하지 않음

## 배포 및 보존

기존 modu-challenge-app 브랜치의 GitHub Actions 배포 경로를 사용한다. Workflow가 운영 D1을 암호화 백업하고 회원·미션·관리자 목록 보존을 확인한 뒤 기존 Worker를 배포한다. 새 마이그레이션, 비밀값 변경, 운영 데이터 삭제는 포함하지 않는다.

## 참고한 공식 문서

- https://developers.portone.io/sdk/ko/v2-sdk/identity-verification-request
- https://developers.portone.io/opi/ko/integration/pg/v2/kcp-v2-identity-verification

© 2026 ISEA GROUP. All Rights Reserved.
