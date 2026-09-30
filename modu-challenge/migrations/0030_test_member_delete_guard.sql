-- Atomic protection: only empty test accounts can be deleted through admin UI.
CREATE TRIGGER test_member_delete_guard BEFORE DELETE ON users
WHEN OLD.is_admin = 1
 OR EXISTS(SELECT 1 FROM admin_roles WHERE user_id=OLD.id)
 OR EXISTS(SELECT 1 FROM challenges WHERE owner_id=OLD.id OR selected_solver_id=OLD.id)
 OR EXISTS(SELECT 1 FROM teasers WHERE solver_id=OLD.id)
 OR EXISTS(SELECT 1 FROM transaction_orders WHERE owner_id=OLD.id OR solver_id=OLD.id)
 OR EXISTS(SELECT 1 FROM mission_simulations WHERE owner_id=OLD.id OR solver_id=OLD.id)
 OR EXISTS(SELECT 1 FROM disputes WHERE opened_by=OLD.id OR respondent_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'TEST_MEMBER_HISTORY'); END;
