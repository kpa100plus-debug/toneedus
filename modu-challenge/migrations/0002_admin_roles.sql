-- 최고관리자와 부관리자 역할을 별도 테이블로 안전하게 분리한다.
CREATE TABLE IF NOT EXISTS admin_roles (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('primary', 'deputy')),
  appointed_by TEXT,
  appointed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (appointed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_role ON admin_roles(role);

-- 기존 관리자는 보수적으로 부관리자로 이관한다.
-- PRIMARY_ADMIN_EMAIL 계정은 로그인 시 Worker가 최고관리자로 승격한다.
INSERT OR IGNORE INTO admin_roles (user_id, role)
SELECT id, 'deputy' FROM users WHERE is_admin = 1;
