-- P3 hosting (ADR-0004, ADR-0010). A project's website lives in one hosting
-- project (Cloudflare Pages): `hosting_ref` is its name there, and the existing
-- `production_ref` holds its stable address. Deployments record how each ended.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hosting_ref text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS error text;

-- Custom domains. A hostname belongs to one website across the whole platform.
-- Whether it is verified is the hosting provider's to say, so it is not stored.
CREATE TABLE IF NOT EXISTS project_domains (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    hostname text NOT NULL UNIQUE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_domains_project ON project_domains (project_id);
ALTER TABLE project_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_project_domains ON project_domains
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
