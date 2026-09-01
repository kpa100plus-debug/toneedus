-- 기존 최고관리자 계정의 공개 표시명을 실명 없이 통일한다.
UPDATE users
SET display_name = 'SUPER ADMIN', updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT user_id FROM admin_roles WHERE role = 'primary');
