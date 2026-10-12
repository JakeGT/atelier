-- A studio member's role on one website, when it differs from their role in the
-- studio (an editor who may only look at one website; a viewer who may edit one).
-- Owners and admins are not overridden.
CREATE TABLE IF NOT EXISTS project_members (
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_project_members ON project_members;
CREATE POLICY tenant_project_members ON project_members
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Usage by month is asked for per studio.
CREATE INDEX IF NOT EXISTS usage_events_tenant_time ON usage_events (tenant_id, occurred_at);
