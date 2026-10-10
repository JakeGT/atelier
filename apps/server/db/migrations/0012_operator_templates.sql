-- P4. The operator can switch parts of Atelier off for one studio
-- (`flags`: {"assistant": false, "publishing": false}; absent means on), and a
-- website remembers the template it was started from until its files are in place.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS flags jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template text;
