-- 공개 챌린지 목록의 주요 정렬 경로를 빠르게 조회한다.
CREATE INDEX IF NOT EXISTS idx_challenges_public_created
  ON challenges(created_at DESC)
  WHERE visibility = 'public' AND status NOT IN ('DRAFT', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_challenges_public_reward
  ON challenges(reward_amount DESC, created_at DESC)
  WHERE visibility = 'public' AND status NOT IN ('DRAFT', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_challenges_public_deadline
  ON challenges(deadline ASC)
  WHERE visibility = 'public' AND status NOT IN ('DRAFT', 'CANCELLED');
