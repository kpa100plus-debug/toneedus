-- Extend the site-wide selection without changing the current selection or revision.
CREATE TABLE home_theme_settings_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'original' CHECK (theme IN (
    'original', 'emerald', 'editorial', 'sunset', 'cobalt',
    'luxury', 'community', 'command', 'magazine', 'journey'
  )),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO home_theme_settings_next (id, theme, revision, updated_by, updated_at)
  SELECT id, theme, revision, updated_by, updated_at FROM home_theme_settings;
DROP TABLE home_theme_settings;
ALTER TABLE home_theme_settings_next RENAME TO home_theme_settings;
