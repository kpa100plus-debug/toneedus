# 모두의클리어 운영 브랜드 전환 · v40

2026-09-18 / REF-MODU-CLEAR-FULL-REBRAND-MIGRATION-20260918-01

공식 브랜드: 모두의클리어. 핵심 문구: 미션을 올리고, 해결하고, 보상받다.
별도 영문 브랜드는 사용하지 않는다. 기존 독립 심볼과 새 한글 워드마크를 분리한다.

## 보존한 기술 식별자
- Worker/D1: modu-challenge / modu-challenge-db; 운영 도메인 동일.
- GitHub 저장소 toneedus, 배포 브랜치 modu-challenge-app 및 workflow 이름.
- /api/challenges, #/explore?challenge=, challengeId 및 challenge 관련 함수·CSS·DOM ID.
- challenges, teasers, challenge_events 등 모든 테이블과 기존 migration 이력.
- MODU_CHALLENGE internalCode, CHALLENGE_* 이벤트·오류코드, 환경변수·GitHub Secret 이름.
- mc_session, mc_oauth_state, mc_oauth_signup 쿠키; modu-* 저장 키와 SW 캐시 접두사.
- manifest id=/, scope=/, start_url=/?source=pwa; 기존 앱 설치 식별자를 유지.
- 기존 이미지 파일명: 이미지에 과거 서비스명 텍스트가 없음을 확인. 공유 URL 버전만 갱신.

DB 마이그레이션/삭제/초기화/테이블 rename 없음. 기존 회원 재가입 불필요.
사용자 작성 원문·이름·감사로그는 보존한다. 과거 시스템 알림은 응답/표시 단계에서만 호환 문구로 변환한다.
brand.js의 과거 브랜드 alias는 이전 알림을 표시하기 위한 코드이며 화면 표시명이나 새 영문 브랜드가 아니다.
기존 법적 운영 주체, 대표자, 약관 동의 버전 및 결제 비활성 정책을 유지한다.

## 배포 및 검증 범위
기존 번들 SHA 검증→회귀검사→Worker dry-run→기존 GitHub Actions 배포.
실제 Google/NAVER 외부 계정과 제공자 콘솔 검수 상태, 실기기 설치·푸시 수신은 인증/기기 접근이 있어야 최종 검증 가능.
외부 OAuth 제공자 동의 화면의 앱 이름은 각 제공자 콘솔에서 별도로 변경해야 하며 Worker 변경만으로 바뀌지 않는다.
설치된 앱 이름 갱신 시점은 브라우저에 따라 다르다. 새로고침·앱 재실행 후에도 예전 이름이 남으면 홈 화면 아이콘을 다시 추가한다.

## 함께 수정한 푸시 오류
- 계정의 다른 기기 구독 존재 여부로 현재 기기 등록을 생략하던 분기 제거.
- 거부 상태에서 반복 권한 요청하지 않으며, 권한 재허용 후 현재 구독을 재등록.
- 현재 기기 구독이 없을 때 다른 기기의 구독을 일괄 해제하던 동작 제거.
- RFC 8291 §3.3의 key_info에 서버 ECDH 공개키를 포함하도록 수정. 수신 측 독립 복호화 검사 추가.
- 참고: https://www.rfc-editor.org/rfc/rfc8291.html#section-3.3
