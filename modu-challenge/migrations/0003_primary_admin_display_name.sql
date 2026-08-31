-- Keep the externally displayed highest-administrator name stable without changing the account email or other data.
UPDATE users
SET display_name = 'juyoungkim', updated_at = CURRENT_TIMESTAMP
WHERE lower(trim(email)) = 'kpa100plus@gmail.com';
