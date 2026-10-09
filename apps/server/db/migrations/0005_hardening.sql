-- P1 hardening (see ADR-0007 release model, ADR-0008 database roles):
--   * memberships behind RLS (visible to the current tenant, or to the current user
--     when routing sign-in), so no tenant-scoped table is left without a policy;
--   * login sessions in the database, so a redeploy does not sign everyone out;
--   * content revision history, so content edits are undoable like code;
--   * release manifests, so a release pins exactly which content it ships.
-- Grants for the non-owner runtime role live in db/grants.sql (re-applied at
-- every start-up, because the role may be created after this migration ran).

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.current_user', true), '')::uuid;
$$ LANGUAGE sql STABLE;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_self_memberships ON memberships
    USING (tenant_id = app_current_tenant() OR user_id = app_current_user())
    WITH CHECK (tenant_id = app_current_tenant());

-- Sessions: the cookie carries a random id; only its SHA-256 is stored, so a
-- database read does not yield usable session cookies.
CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    auth_time timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Every draft write appends a revision; restoring one writes it back as a new draft.
CREATE TABLE IF NOT EXISTS content_revisions (
    id bigserial PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    rev bigint NOT NULL,
    draft jsonb,
    updated_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, rev),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_content_revisions ON content_revisions
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Backfill: the current draft of every existing document becomes its first revision.
ALTER TABLE content_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE content_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_revisions DISABLE ROW LEVEL SECURITY;
INSERT INTO content_revisions (document_id, project_id, tenant_id, rev, draft, updated_by, created_at)
    SELECT id, project_id, tenant_id, rev, draft, updated_by, updated_at FROM content_documents
    ON CONFLICT (document_id, rev) DO NOTHING;
ALTER TABLE content_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_revisions FORCE ROW LEVEL SECURITY;

-- A release's manifest: the exact content (document -> revision + body) it ships.
-- `content_documents.published` is only ever written from the manifest of the
-- release that went live, so the database always matches the live site.
CREATE TABLE IF NOT EXISTS release_documents (
    release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    document_id uuid NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    rev bigint NOT NULL,
    content jsonb NOT NULL,
    PRIMARY KEY (release_id, document_id),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE release_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_release_documents ON release_documents
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- At most one live release per project, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS releases_one_live_per_project ON releases (project_id) WHERE state = 'live';
