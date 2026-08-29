# MODU CHALLENGE 배포 상태

기준일: 2026-08-29  
버전: V0.5.4

## Cloudflare 운영 자원

- 서비스: https://modu-challenge.yeit.workers.dev
- 관리자 페이지: https://modu-challenge.yeit.workers.dev/#/admin
- 상태 점검: https://modu-challenge.yeit.workers.dev/api/health
- Worker: `modu-challenge`
- Worker 버전: `186e9b36-7a44-4f4b-9499-da69afd383f5`
- D1: `modu-challenge-db`
- D1 ID: `472f68ee-24da-4d11-b9c8-6a8f2ee597be`
- Cron: `0 * * * *`

## 완료

- Cloudflare Worker API·정적 PWA·D1·Cron 실제 배포
- 회원가입·로그인·HttpOnly 세션
- 브라우저 PBKDF2-SHA256 210,000회 및 서버측 검증자 재해시
- 챌린지 등록·검색·상세·취소
- TEASER·SHORTLIST·FINALIST
- 후행 Funding·증빙·성공판정·정산원장
- OWNER/SOLVER TRUST·양방향 리뷰
- 3-Strike·신고·분쟁·Audit Log
- 관리자 Overview 및 원격 D1 최고관리자 별도 프로비저닝
- 공개 소스에서 활성 관리자 해시·Salt·로그인 정보 제거
- PC·모바일 PWA 및 스테이징 검색색인 차단

## 검수 결과

- 라이브 API E2E 8/8 통과
- JavaScript·Worker 문법 검사 통과
- 분할 번들 SHA-256 및 14개 런타임 파일 검사 통과
- D1 마이그레이션에서 관리자 Seed 제거 확인
- 보상금 1,000,000원 기준: 플랫폼 100,000원 / 성공 참가자 900,000원
- 스테이징 실제 돈 게이트: `MONEY_FLOW_DISABLED`

## 최고관리자

현재 최고관리자는 원격 D1에 별도로 설정되어 있습니다.

- 공개 표시명: `juyoungkim`
- 관리자 비밀번호와 활성 로그인 검증값은 공개 GitHub 저장소에 없음
- 소스 준비 및 재배포 과정에서 관리자 레코드를 생성하거나 덮어쓰지 않음

## 실제 결제 상태

회원가입·로그인·챌린지·TEASER·SHORTLIST 데이터 기능은 운영형 스테이징으로 사용할 수 있습니다.

Funding·실결제·지급·10% 자동정산은 PG·지급대행 계약, Webhook 서명검증, 약관·환불·세무정책 최종 검수 전까지 비활성화 상태로 유지합니다.

© 2026 ISEA GROUP. All Rights Reserved.
