-- One site-wide homepage concept. Keep the current design on upgrade.
CREATE TABLE IF NOT EXISTS home_theme_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'original' CHECK (theme IN ('original', 'emerald', 'editorial', 'sunset', 'cobalt')),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO home_theme_settings(id, theme) VALUES (1, 'original');
