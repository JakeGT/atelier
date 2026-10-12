-- A studio's own starting points: a website saved as a template, to begin other
-- websites from. Its files and wording are copied in when it is saved, so the
-- template does not change (or disappear) when the website it came from does.
CREATE TABLE IF NOT EXISTS studio_templates (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- [{ path, content (base64) }]
    files jsonb NOT NULL,
    -- [{ kind, slug, draft, fields }]
    content jsonb NOT NULL DEFAULT '[]',
    -- The website it was saved from: its pictures are copied from there while it exists.
    source_project uuid,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_templates_tenant ON studio_templates (tenant_id, created_at);
ALTER TABLE studio_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_studio_templates ON studio_templates;
CREATE POLICY tenant_studio_templates ON studio_templates
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
