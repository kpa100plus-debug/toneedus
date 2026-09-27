# 모두의클리어 외부 인증·거래 연결 준비

REF-MODUCLEAR-NEW-CHAT-FINAL-COMPLETION-20260927-01 · 2026-09-27 KST

운영·관리: (주)ISEA GROUP. 이 문서는 현재 소스의 연결 경로와 남은 준비사항이다. 계약 존재 여부나 실제 외부 인증·입금·지급 성공을 증명하지 않는다. 운영 조회에서는 본인확인 연결이 비활성이고 실제 금전 기능은 비활성이다. 환경변수 값이나 키 원문은 이 문서에 기록하지 않는다.

## 고정 주소

| 용도 | 주소 |
|---|---|
| 운영·인증 복귀 도메인 | https://modu-challenge.yeit.workers.dev/ |
| 관리자 | https://modu-challenge.yeit.workers.dev/#/admin |
| 인증·거래 상태 | https://modu-challenge.yeit.workers.dev/api/launch-readiness |
| 서비스 설정 | https://modu-challenge.yeit.workers.dev/api/config |
| 개인정보 안내 | https://modu-challenge.yeit.workers.dev/#/privacy |
| 이용약관 | https://modu-challenge.yeit.workers.dev/#/terms |
| 기존 GitHub | https://github.com/kpa100plus-debug/toneedus/tree/modu-challenge-app |

## 실명 본인확인

구현 공급자는 PortOne V2다. NICE·KCB·PASS 등 다른 기관과 계약되어 있다고 가정하지 않는다. 이메일 인증은 실명확인 완료로 취급하지 않는다.

- 공개 설정: `IDENTITY_VERIFICATION_PROVIDER=portone-v2`, `PORTONE_STORE_ID`, `PORTONE_IDENTITY_CHANNEL_KEY`.
- 서버 시크릿: `PORTONE_API_SECRET`, 최소 32자의 `IDENTITY_HASH_SECRET`.
- 계약·실제 결과 검증을 마친 경우에만 `IDENTITY_INTEGRATION_APPROVED=true`.
- 세션 인증 시작: `POST /api/me/identity/start`.
- 브라우저/모바일 SDK 복귀: 운영 도메인 `/?identityVerificationId=...`를 처리하고 원래 화면으로 돌아간다.
- 완료 확인: `POST /api/me/identity/complete`. 브라우저 성공 메시지를 신뢰하지 않고 서버가 공급자 결과를 조회한다.
- 공급자 조회: `GET https://api.portone.io/identity-verifications/{id}?storeId=...`.
- 계정·요청·이름·휴대전화·성년 여부·기관 결과·만료를 대조한다. CI/DI 원문을 저장하거나 공개하지 않는다.
- 인증 요청 재사용으로 취소·만료된 인증을 복구할 수 없다. 동시에 완료 요청이 들어와도 한 번만 저장·감사기록 처리한다.

신청 정보는 실제 법인 등록정보에 맞는 상호, 사업자번호, 주소, 회사 관리 연락처, 인증 목적 및 처리범위가 필요하다. 서비스 표시용 `(주)ISEA GROUP`을 법인등기부의 정확한 법정 상호로 임의 간주하지 않는다. 실제 신청·계약 제출은 수행하지 않았다.

## 사업자·법인·단체

- 국세청 진위·계속사업 조회 시크릿: `NTS_API_KEY`.
- 안전한 증빙 저장: 64자리 16진수 `EVIDENCE_ENCRYPTION_KEY`.
- 자격 검증 정책 승인: `ENTITY_REVIEW_POLICY_APPROVED=true`.
- 내 자격 신청: `/api/me/entity-cases`; 최고관리자 예외 검토: `/api/admin/entity-cases`.
- 국세청 조회 어댑터: `POST https://api.odcloud.kr/api/nts-businessman/v1/validate`.
- 개인사업자 본인이 대표자로 신청하고 현재 실명확인 결과와 대표자명이 일치하면, 제출 시 국세청 진위·계속사업 결과를 자동 대조한다. 일치하는 정상 사업자만 자동 확인하며 일상 관리자 승인 대기를 만들지 않는다. 키 부재·기관 오류·휴폐업·불일치에는 완료로 처리하지 않는다.
- 자격 원본은 암호화하고 30일 후 파기한다. 원본 조회는 권한 검사 및 열람 기록을 남긴다.
- 휴업·폐업 응답은 유효 상태로 승인하지 않는다. 취소·만료된 인증을 재사용하지 않는다.
- 법인·단체 또는 위임관계처럼 자동 대조할 수 없는 예외에는 등록자료·권한 증빙 확인이 필요하다.

## 결제·지급

현재 `moneyEnabled=false`, `moneyMode=disabled`, `PUBLIC_MONEY_ENABLED=false`를 유지한다. `LIVE_FINANCIAL_ADAPTERS_RELEASED=false`이므로 운영키나 환경변수만 입력해서 실제 결제·지급이 활성화되지 않는다.

격리된 개발 테스트 전용 어댑터 설정은 `APP_ENV=test`, `PROVIDER_SANDBOX_ENABLED=true`, `TOSS_SECRET_KEY`의 `test_sk_` 접두사, 지급 암호화용 `TOSS_PAYOUT_SECURITY_KEY`다. 실서비스에 `APP_ENV=test`를 설정하지 않는다.

- 샌드박스 웹훅 경로: `POST /api/provider-webhooks/toss`.
- 지급 이벤트는 원문·전송시간 HMAC-SHA256 서명을 검증하고 공급자 조회 결과를 다시 확인한다.
- 일반 결제 이벤트에는 공급자 서명 헤더가 없으므로, 알려진 거래번호의 인증된 결제 조회 결과만 증거로 사용한다.
- 원 금액·수수료 스냅샷, 불변 이벤트·원장, 요청 멱등성, 지급 중복 방지 및 서버 금액 대조를 유지한다.
- TEST 원장과 관리자 SIMULATION은 부분 환불→잔액 수수료·수령액 재계산→잔액 환불/지급까지 검사한다. 실제 청구·송금은 0원이다.
- 공급자 부분환불 전송·부분환불 후 지급은 아직 미개방이다. `PARTIAL_REFUND_PROVIDER_NOT_RELEASED`로 차단하며 실제 성공으로 표시하지 않는다.

남은 외부 단계: 계약된 본인확인 채널/운영 자격증명 확인, 국세청 활용키, PG·지급대행 사업 심사, 셀러·예금주 확인, 공급자 공식 테스트 및 정산·환불 대사, 실제 서비스 승인, 별도 명시적인 실결제 활성화 승인. 계좌·카드·신분증·비밀키를 GitHub나 채팅 보고서에 넣지 않는다.

## 확인 근거와 시험 범위

- 신규 본인확인·웹훅 보안 13개 그룹, 부분환불 6개 그룹: 로컬 SQLite와 공급자 모의응답 검사.
- 기존 launch 12개 그룹, adapters 13개 그룹: 로컬 회귀검사.
- 실제 SMS/PASS 인증, 외부 PG 공식 샌드박스 승인 및 실제 결제·지급은 이 검사에 포함되지 않는다.
- Toss 공식 웹훅 형식 확인: https://docs.tosspayments.com/reference/using-api/webhook-events
- 공식 결제 웹훅 검증 구분: https://docs.tosspayments.com/guides/v2/get-started/llms-quick-reference

© 2026 ISEA GROUP. All Rights Reserved.
