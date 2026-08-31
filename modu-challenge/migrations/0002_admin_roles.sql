-- 최고관리자와 부관리자 역할을 분리한다.
ALTER TABLE users ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'member'
  CHECK (admin_role IN ('member', 'primary', 'deputy'));

-- 기존 관리자 계정은 안전하게 부관리자로 유지하고,
-- PRIMARY_ADMIN_EMAIL 계정이 로그인하면 Worker가 최고관리자로 승격한다.
UPDATE users
SET admin_role = CASE WHEN is_admin = 1 THEN 'deputy' ELSE 'member' END;
