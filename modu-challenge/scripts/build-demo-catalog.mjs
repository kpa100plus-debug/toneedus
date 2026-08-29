import { writeFile } from 'node:fs/promises';

const catalog = [
  {
    category: 'CONNECT', owner: '커넥트브릿지(예시)', trust: 94, region: '전국·온라인',
    evidence: '상대방 동의기록, 담당자 직책 확인자료, 미팅 일정 및 완료 확인',
    items: [
      ['친환경 포장재 제조사 의사결정권자를 연결해주세요', '식품용 친환경 패키징 양산이 가능한 국내 제조사와 공식 협의할 수 있는 연결을 찾습니다.', 3000000, '인증 대응이 가능한 제조사 의사결정권자가 연결을 수락하고 60분 이상 미팅 완료'],
      ['일본 K-뷰티 유통 바이어와 온라인 상담을 연결해주세요', '한국 화장품을 취급하는 일본 현지 유통사의 구매 담당자와 상담 기회를 찾습니다.', 2500000, '일본 유통사 구매 담당자 확인과 제품 소개 미팅 1회 완료'],
      ['공공기관 복지몰 상품기획 담당자를 만나게 해주세요', '중소기업 생활용품 입점을 검토할 수 있는 공공기관 복지몰 담당자 연결이 필요합니다.', 1800000, '복지몰 입점 권한이 있는 담당자와 공식 상품 제안 미팅 완료'],
      ['수도권 시니어타운 제휴 담당자 5명을 연결해주세요', '건강·생활 서비스를 제안할 수 있는 시니어타운 운영사 제휴 담당자를 찾습니다.', 4000000, '조건에 맞는 운영사 5곳의 담당자 동의와 상담 일정 확정'],
      ['반려동물 전문 크리에이터 공동캠페인을 성사시켜주세요', '반려생활 신제품을 함께 알릴 신뢰도 높은 크리에이터 협업을 추진합니다.', 1200000, '후보 3명의 참여 조건 확인과 최종 1명 캠페인 일정 확정'],
    ],
  },
  {
    category: 'FIND', owner: '리서치허브(예시)', trust: 91, region: '전국',
    evidence: '공식 홈페이지·인증자료, 담당부서 확인기록, 조건 비교표 및 출처 링크',
    items: [
      ['고령친화 식품 OEM 생산업체 3곳을 찾아주세요', '소량 초도생산과 HACCP 대응이 가능한 고령친화 식품 제조사를 비교해주세요.', 1000000, '필수조건을 충족한 업체 3곳의 MOQ·인증·일정·담당부서 확인'],
      ['24시간 소형 냉장물류 서비스를 비교해주세요', '수도권 새벽배송과 소량 냉장보관이 가능한 물류업체를 조건별로 찾습니다.', 600000, '당일 대응 가능한 물류사 5곳의 요금·권역·최소물량 비교 완료'],
      ['국산 천연원료 안전성 시험기관을 찾아주세요', '화장품 원료의 성분·안전성·미생물 시험을 진행할 공인기관을 조사합니다.', 800000, '시험항목과 견적이 확인된 기관 3곳 및 담당창구 제출'],
      ['서울 500명 규모 기업행사장을 찾아주세요', '대중교통 접근성·주차·무대·식사가 가능한 행사장을 예산 내에서 비교합니다.', 500000, '지정 날짜 예약 가능 행사장 5곳의 견적과 시설조건 확인'],
      ['동남아 3개국 상표출원 대리인을 비교해주세요', '베트남·태국·인도네시아 상표출원 경험이 있는 현지 협력 대리인을 찾습니다.', 1500000, '국가별 대리인 2곳 이상과 비용·기간·경력 비교자료 제출'],
    ],
  },
  {
    category: 'IDEA', owner: '아이디어스튜디오(예시)', trust: 89, region: '전국·온라인',
    evidence: '기획서, 실행 일정, 예산안, 예상 KPI와 참고사례 출처',
    items: [
      ['지방소멸 위기 마을의 30일 체류 프로그램을 설계해주세요', '청년·중장년 100명이 머물며 지역소비와 관계인구를 만드는 실행안을 찾습니다.', 5000000, '예산 1억원 이내에서 90일 안에 실행 가능한 운영안과 KPI 승인'],
      ['중장년 소비자 앱의 이름과 슬로건을 제안해주세요', '신뢰·혜택·참여가 한 번에 전달되는 기억하기 쉬운 브랜드 언어가 필요합니다.', 700000, '상표 기초검색을 통과한 이름 10개와 슬로건·선정근거 제출'],
      ['폐현수막을 활용한 판매상품 아이디어를 공모합니다', '재활용에 그치지 않고 반복 구매가 가능한 업사이클링 상품군을 찾습니다.', 900000, '제작원가와 판매가가 포함된 상품 5종 및 시제품 설계안 제출'],
      ['전통시장 야간 방문을 늘릴 콘텐츠를 제안해주세요', '상인과 주민이 함께 운영하면서 매출로 연결되는 저녁 프로그램이 필요합니다.', 1300000, '8주 운영표·상인참여 구조·매출 측정방식이 포함된 실행안 승인'],
      ['1인 가구 고립을 줄이는 생활서비스를 설계해주세요', '개인정보 침해 없이 안부·식사·활동 연결을 만드는 지속가능한 모델을 찾습니다.', 2000000, '대상자 동의·위기대응·운영비를 포함한 3개월 실증계획 완성'],
    ],
  },
  {
    category: 'BUSINESS', owner: '비즈니스그로스랩(예시)', trust: 96, region: '전국',
    evidence: '현황 분석표, 실행계획, 검증 가능한 성과지표와 최종 결과보고서',
    items: [
      ['전국 100개 카페 납품이 가능한 유통 파트너를 확보해주세요', '신제품 시범판매를 진행할 지역 유통사 또는 카페 네트워크 운영자를 찾습니다.', 7000000, '100개 매장의 참여의사 확인과 최소 50개 매장 첫 발주 완료'],
      ['구독서비스 90일 이탈률을 20% 낮춰주세요', '가입 후 3개월 내 이탈 원인을 분석하고 유지율 개선 실험을 실행합니다.', 4500000, '동일 기준 대비 90일 이탈률 20% 이상 개선 및 실험결과 제출'],
      ['B2B 영업 제안서의 상담 전환율을 높여주세요', '산업용 솔루션 제안서를 재구성하고 실제 잠재고객 반응으로 검증합니다.', 1800000, '신규 제안서 적용 후 유효 상담 전환율 15% 이상 달성'],
      ['수출 견적·승인 프로세스를 3일 이내로 줄여주세요', '부서별로 흩어진 견적 절차를 표준화해 해외문의 대응속도를 개선합니다.', 3000000, '견적 요청부터 최종 승인까지 평균 소요일 3일 이내 달성'],
      ['오프라인 매장의 재방문율 개선안을 실행해주세요', '구매데이터와 현장 관찰을 바탕으로 8주간 재방문 실험을 진행합니다.', 2200000, '대상 매장 3곳의 8주 재방문율 평균 10% 이상 개선'],
    ],
  },
  {
    category: 'ACTION', owner: '액션메이커스(예시)', trust: 93, region: '전국',
    evidence: '참가동의, 현장 QR·사진·영상, 수행 체크리스트와 결과보고서',
    items: [
      ['한강 지류 정화 1,000명 공동행동을 운영해주세요', '안전관리와 전후 데이터를 남기는 시민 정화 프로젝트 운영팀을 찾습니다.', 10000000, '참가 1,000명·중대사고 0건·수거량 검증이 포함된 결과보고 완료'],
      ['3일간 박람회 현장 운영팀을 구성해주세요', '안내·등록·무대·VIP 동선을 맡을 숙련 운영인력 30명이 필요합니다.', 3500000, '교육 이수 인력 30명 배치와 3일 운영 체크리스트 98% 이상 완료'],
      ['전국 300개 매장의 가격표시를 조사해주세요', '표준 체크리스트로 실제 판매가격과 프로모션 표시 상태를 확인합니다.', 2800000, '권역별 300개 매장의 위치·시간·표시사진이 포함된 조사 완료'],
      ['신제품 사용성 인터뷰 50명을 진행해주세요', '목표 고객을 모집해 제품 사용 과정을 관찰하고 개선점을 정리합니다.', 1700000, '조건에 맞는 50명 인터뷰와 익명화된 인사이트 보고서 제출'],
      ['지역축제 현장 숏폼 영상 30편을 제작해주세요', '행사 분위기와 상인 이야기를 담은 세로형 홍보콘텐츠가 필요합니다.', 2400000, '브랜드 가이드에 맞는 15~45초 영상 30편 검수 완료'],
    ],
  },
  {
    category: 'LOCAL', owner: '로컬브릿지(예시)', trust: 88, region: '지역별',
    evidence: '현장조사 기록, 참여의향서, 지도·운영표, 지역협력 확인자료',
    items: [
      ['빈 상가 10곳을 활용한 야간문화거리 실행안을 찾아주세요', '유휴상가를 연결해 8주간 팝업·공연·지역소비를 만드는 프로젝트입니다.', 3000000, '상가 10곳 참여의사와 8주 운영·안전·민원계획 승인'],
      ['골목상권의 숨은 가게 100곳 지도를 만들어주세요', '관광객과 주민이 쉽게 찾도록 이야기와 동선을 담은 디지털 지도를 제작합니다.', 1200000, '검증된 가게 100곳의 위치·운영정보·소개문구 등록 완료'],
      ['로컬푸드 공동배송 시범사업을 운영해주세요', '농가와 도심 소비자를 주 2회 연결하는 저비용 공동배송 모델을 시험합니다.', 2600000, '농가 20곳·소비자 200명 참여와 8주 배송완료율 95% 달성'],
      ['마을 빈집 200곳의 활용 가능성을 조사해주세요', '소유관계 공개 없이 외관·접근성·상태를 표준화해 조사합니다.', 1900000, '빈집 200곳의 비식별 상태등급·위치권역·활용유형 조사 완료'],
      ['주민 걷기모임 20개를 만들어주세요', '세대가 함께 참여하는 주 1회 생활권 걷기모임을 지역별로 구성합니다.', 900000, '리더 20명과 모임별 10명 이상 참여, 4주 운영기록 확인'],
    ],
  },
  {
    category: 'SOCIAL', owner: '소셜임팩트랩(예시)', trust: 92, region: '전국',
    evidence: '본인동의, 협력기관 확인, 교육·활동 기록과 개인정보 비식별 통계',
    items: [
      ['중장년 디지털 재능기부자 500명을 연결해주세요', '스마트폰·키오스크·공공앱 사용을 돕는 지역별 지원단을 구성합니다.', 2000000, '본인동의 가입 500명과 기본교육 수료 400명 이상 확보'],
      ['결식우려 아동의 방학 식사지원망을 연결해주세요', '지역 가게와 후원자가 지속적으로 참여하는 안전한 연결모델을 찾습니다.', 3200000, '협력기관 검증을 거친 10개 지역·300명 지원계획과 운영동의 확보'],
      ['유기동물 입양 인식개선 캠페인을 실행해주세요', '보호소 정보와 책임입양 원칙을 알리는 참여형 캠페인을 운영합니다.', 1600000, '공식 보호소 5곳 협력과 캠페인 참여 3,000명 달성'],
      ['시각장애인 관점에서 공공웹 접근성을 점검해주세요', '주요 민원서비스의 실제 이용 장벽을 당사자 참여 방식으로 확인합니다.', 2300000, '20개 서비스 핵심과업 점검과 재현 가능한 개선보고서 제출'],
      ['자립준비청년 직무 멘토 100명을 모집해주세요', '일회성 강연이 아닌 3개월 동행형 직무 멘토링 풀을 구성합니다.', 2800000, '검증된 멘토 100명과 3개월 활동동의·분야별 배치표 확정'],
    ],
  },
  {
    category: 'PUBLIC', owner: '공공혁신연구소(예시)', trust: 95, region: '전국',
    evidence: '공식자료 출처, 조사 설계, 익명화된 결과데이터와 정책 제안서',
    items: [
      ['재난문자의 고령층 이해도를 높이는 문안을 만들어주세요', '긴급상황에서 바로 행동할 수 있도록 쉬운 표현과 구조를 검증합니다.', 1400000, '고령층 100명 이해도 조사에서 핵심행동 정답률 85% 이상 달성'],
      ['공공서비스 민원용어 100개를 쉽게 바꿔주세요', '시민이 자주 막히는 행정용어를 의미 손실 없이 쉬운 말로 개선합니다.', 1100000, '법적 의미 검토와 시민평가를 통과한 쉬운 표현 100개 확정'],
      ['휠체어 이용자를 위한 무장애 관광경로를 조사해주세요', '교통·경사·화장실·출입구를 실제 이동 기준으로 확인한 경로가 필요합니다.', 2700000, '5개 관광권역의 실측 경로·장애요소·대체동선 지도 완성'],
      ['소상공인 지원정책 검색도우미를 설계해주세요', '복잡한 공고문을 업종·지역·상황별로 찾게 하는 정보구조를 만듭니다.', 3600000, '정책 200건 분류와 대표질문 30개 검색 성공률 90% 달성'],
      ['어린이 보호구역 안전 취약지점을 제안해주세요', '보행 관찰과 주민 제보를 결합해 개선 우선순위를 정합니다.', 2100000, '10개 지역 100개 지점 조사와 근거자료가 포함된 우선순위 제안'],
    ],
  },
];

const statusByIndex = ['OPEN', 'OPEN', 'REVIEW', 'SHORTLISTED', 'SUCCESS'];
const deadlineByIndex = [
  '2026-10-15T23:59:59+09:00',
  '2026-11-03T23:59:59+09:00',
  '2026-10-28T23:59:59+09:00',
  '2026-11-20T23:59:59+09:00',
  '2026-08-25T23:59:59+09:00',
];

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

const lines = [
  '-- MODU CHALLENGE preview-only catalog. Every record uses a demo_ ID and reserved .invalid email.',
  '-- Safe removal: npm run demo:clear:remote',
  'PRAGMA foreign_keys = ON;',
  "DELETE FROM challenges WHERE id LIKE 'demo_ch_%';",
];

const demoUsers = [
  ...catalog.map((group, index) => ({
    id: `demo_owner_${group.category.toLowerCase()}`,
    email: `${group.category.toLowerCase()}-owner@demo.invalid`,
    displayName: group.owner,
    accountType: index % 2 ? 'organization' : 'corporation',
    trust: group.trust,
    businessVerified: 1,
    professionalVerified: index % 3 === 0 ? 1 : 0,
  })),
  { id: 'demo_solver_haneul', email: 'haneul-solver@demo.invalid', displayName: '김하늘(예시 참여자)', accountType: 'individual', trust: 91, businessVerified: 0, professionalVerified: 0 },
  { id: 'demo_solver_doyun', email: 'doyun-solver@demo.invalid', displayName: '박도윤(예시 전문가)', accountType: 'business', trust: 93, businessVerified: 1, professionalVerified: 1 },
];

for (const user of demoUsers) {
  lines.push(`INSERT INTO users (
  id, email, password_hash, password_salt, display_name, account_type, status,
  is_admin, identity_verified, business_verified, professional_verified,
  email_verified, terms_version, terms_accepted_at, privacy_version,
  privacy_accepted_at, trust_score, strike_count, bounty_limit
) VALUES (
  ${sql(user.id)}, ${sql(user.email)}, 'disabled-demo-account', 'disabled-demo-account',
  ${sql(user.displayName)}, ${sql(user.accountType)}, 'active', 0, 1,
  ${user.businessVerified}, ${user.professionalVerified}, 1,
  '2026-08-29-v1', CURRENT_TIMESTAMP, '2026-08-29-v1', CURRENT_TIMESTAMP,
  ${user.trust}, 0, 1000000000
) ON CONFLICT(id) DO UPDATE SET
  email = excluded.email,
  password_hash = 'disabled-demo-account',
  password_salt = 'disabled-demo-account',
  display_name = excluded.display_name,
  account_type = excluded.account_type,
  status = 'active',
  is_admin = 0,
  identity_verified = 1,
  business_verified = excluded.business_verified,
  professional_verified = excluded.professional_verified,
  trust_score = excluded.trust_score,
  strike_count = 0,
  bounty_limit = 1000000000;`);
}

catalog.forEach((group, categoryIndex) => {
  group.items.forEach(([title, summary, reward, successCriteria], itemIndex) => {
    const suffix = String(itemIndex + 1).padStart(2, '0');
    const challengeId = `demo_ch_${group.category.toLowerCase()}_${suffix}`;
    const ownerId = `demo_owner_${group.category.toLowerCase()}`;
    const status = statusByIndex[itemIndex];
    const solverId = status === 'SUCCESS' ? (categoryIndex % 2 ? 'demo_solver_doyun' : 'demo_solver_haneul') : null;
    const fundingStatus = status === 'SUCCESS' ? 'PAID' : 'POSTED';
    const participants = 8 + categoryIndex * 3 + itemIndex * 5;
    const teasers = Math.max(3, Math.round(participants * 0.55));
    const shortlisted = status === 'SHORTLISTED' || status === 'SUCCESS' ? 3 : 0;
    const views = 320 + categoryIndex * 137 + itemIndex * 211;
    const description = `[미리보기용 예시 데이터] ${summary} 실제 운영 시에는 개설자가 조건·기한·증빙을 확정하고, 참가자는 민감정보를 가린 TEASER로 해결 가능성을 제시합니다.`;
    const paymentTrigger = '개설자가 TEASER와 TRUST를 검토해 최종 수행자를 선택하고, 사전 운영 정책에 따른 Funding 준비를 확인한 시점';
    const createdDay = String(9 + categoryIndex * 2 + itemIndex).padStart(2, '0');
    lines.push(`INSERT INTO challenges (
  id, owner_id, title, summary, description, category, region,
  reward_amount, fee_rate, success_criteria, payment_trigger,
  evidence_requirements, deadline, status, funding_status, selected_solver_id,
  visibility, participant_count, teaser_count, shortlisted_count, view_count,
  created_at, updated_at
) VALUES (
  ${sql(challengeId)}, ${sql(ownerId)}, ${sql(`[예시] ${title}`)}, ${sql(summary)},
  ${sql(description)}, ${sql(group.category)}, ${sql(group.region)}, ${reward}, 0.10,
  ${sql(successCriteria)}, ${sql(paymentTrigger)}, ${sql(group.evidence)},
  ${sql(deadlineByIndex[itemIndex])}, ${sql(status)}, ${sql(fundingStatus)}, ${sql(solverId)},
  'public', ${participants}, ${teasers}, ${shortlisted}, ${views},
  ${sql(`2026-08-${createdDay}T0${(categoryIndex + itemIndex) % 9}:00:00+09:00`)}, CURRENT_TIMESTAMP
);`);

    if (status === 'SUCCESS') {
      const reviewerId = solverId;
      lines.push(`INSERT INTO reviews (
  id, challenge_id, reviewer_id, reviewee_id, reviewer_role,
  rating, accuracy, responsiveness, reliability, would_work_again, comment
) VALUES (
  ${sql(`demo_review_${group.category.toLowerCase()}`)}, ${sql(challengeId)}, ${sql(reviewerId)}, ${sql(ownerId)},
  'SOLVER', 5, 5, 5, 5, 1,
  ${sql('예시 후기입니다. 성공조건과 일정이 명확했고 진행 과정의 응답이 빨랐습니다.')}
);`);
    }
  });
});

lines.push("SELECT COUNT(*) AS demo_users FROM users WHERE id LIKE 'demo_%';", "SELECT COUNT(*) AS demo_challenges FROM challenges WHERE id LIKE 'demo_ch_%';");

await writeFile(new URL('./demo-catalog.sql', import.meta.url), `${lines.join('\n\n')}\n`, 'utf8');
console.log(`Built ${catalog.length * 5} preview challenges across ${catalog.length} categories.`);
