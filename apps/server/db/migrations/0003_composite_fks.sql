-- Composite foreign keys on tenant-scoped child tables.
--
-- Postgres does NOT apply RLS when checking foreign keys, so a plain
-- `project_id REFERENCES projects(id)` is not enough: a child row could carry
-- tenant A's id while referencing tenant B's project. A composite FK on
-- (project_id, tenant_id) ties the two together, so the tenant can never be
-- fabricated independently of the project.

ALTER TABLE projects ADD CONSTRAINT projects_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE content_documents DROP CONSTRAINT content_documents_project_id_fkey;
ALTER TABLE content_documents ADD CONSTRAINT content_documents_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE media_assets DROP CONSTRAINT media_assets_project_id_fkey;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE releases DROP CONSTRAINT releases_project_id_fkey;
ALTER TABLE releases ADD CONSTRAINT releases_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE deployments DROP CONSTRAINT deployments_project_id_fkey;
ALTER TABLE deployments ADD CONSTRAINT deployments_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_project_id_fkey;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_project_tenant_fkey
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;
