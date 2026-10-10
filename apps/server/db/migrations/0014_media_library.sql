-- The media library (ADR-0014 §5). media_assets has existed since 0002 without
-- being used; these columns are what the library needs. Files themselves live in
-- object storage under `key`.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'image';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS decorative boolean NOT NULL DEFAULT false;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS uploaded_by uuid;
-- Removed from the library but kept for a while, so an earlier release that
-- used the file can still be put back (see the retention job).
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_project_name ON media_assets (project_id, name);
