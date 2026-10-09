-- Tenancy foundation: the authoritative tenant catalog (control schema) and the
-- tenant-scoped tables, all behind Postgres Row-Level Security.
--
-- Tenant scoping: every tenant-scoped table carries `tenant_id`, which equals the
-- owning organization's id (organizations.id). The application sets
-- `app.current_tenant` (transaction-local) per request; RLS fails closed when it
-- is unset. `control.tenants` and `audit_log` are NOT tenant-scoped.

CREATE SCHEMA IF NOT EXISTS control;

-- Authoritative catalog. Reached only by the control plane.
CREATE TABLE IF NOT EXISTS control.tenants (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    data_scope text NOT NULL DEFAULT 'shared',
    status text NOT NULL DEFAULT 'active',
    region text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The current tenant for RLS. NULL when unset -> all tenant rows invisible.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- organizations: 1:1 with a tenant. organizations.id IS the tenant id.
CREATE TABLE IF NOT EXISTS organizations (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
    tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    invited_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    content_schema_ref text,
    agent_config_ref text,
    preview_ref text,
    production_ref text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

-- content documents: the content store. A document carries draft and published
-- revisions and a monotonic `rev` for optimistic concurrency.
CREATE TABLE IF NOT EXISTS content_documents (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    schema_version text,
    draft jsonb,
    published jsonb,
    published_at timestamptz,
    rev int NOT NULL DEFAULT 0,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, kind, slug)
);

CREATE TABLE IF NOT EXISTS media_assets (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    key text NOT NULL,
    mime text,
    width int,
    height int,
    alt text,
    bytes bigint,
    draft_ref text,
    published_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS releases (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    number int NOT NULL,
    state text NOT NULL DEFAULT 'planned',
    code_sha text,
    content_rev int,
    actor_id uuid,
    rollback_of uuid,
    deployed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS deployments (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
    kind text NOT NULL,
    provider text,
    provider_ref text,
    url text,
    state text NOT NULL DEFAULT 'building',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    workspace_id text,
    model text,
    status text NOT NULL DEFAULT 'provisioning',
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS usage_events (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL,
    project_id uuid,
    kind text NOT NULL,
    units numeric,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    meta jsonb
);

-- audit log: append-only, NOT tenant-scoped (it outlives its subjects).
CREATE TABLE IF NOT EXISTS audit_log (
    id bigserial PRIMARY KEY,
    tenant_id uuid,
    actor_id uuid,
    action text NOT NULL,
    target text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    detail jsonb
);

-- RLS: enable + FORCE on every tenant-DATA table. FORCE matters because the app
-- connects as the table owner (the `atelier` role), which otherwise bypasses RLS.
-- `memberships` is a control-plane relationship table (queried by user_id to route
-- sign-in) and carries no RLS in P1; a BYPASSRLS admin role + RLS on memberships
-- is a P2 hardening item.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE content_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_organizations ON organizations
    USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenant_projects ON projects
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_content ON content_documents
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_media ON media_assets
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_releases ON releases
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_deployments ON deployments
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_sessions ON agent_sessions
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_usage ON usage_events
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
