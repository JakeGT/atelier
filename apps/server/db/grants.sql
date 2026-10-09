-- Privileges for the runtime role, re-applied (idempotently) after migrations at
-- every start-up. The server's runtime connection should log in as a member of
-- `atelier_runtime`, which owns nothing: it cannot ALTER TABLE ... DISABLE ROW
-- LEVEL SECURITY, cannot rewrite the audit log, and cannot run migrations. The
-- table owner (`atelier`) is used only to migrate. See ADR-0008 and docs/14.
--
-- If the role does not exist (local dev, compose.example), this is a no-op and
-- the server runs as the owner with FORCE ROW LEVEL SECURITY as the boundary.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier_runtime') THEN
        RAISE NOTICE 'role atelier_runtime does not exist; skipping runtime grants';
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA public, control TO atelier_runtime;
    GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user() TO atelier_runtime;

    -- Tenant-scoped tables (RLS applies to the runtime role) and identity tables.
    GRANT SELECT, INSERT, UPDATE, DELETE ON
        organizations, memberships, projects, content_documents, content_revisions,
        media_assets, releases, release_documents, deployments, agent_sessions,
        users, sessions
        TO atelier_runtime;
    GRANT SELECT, INSERT ON usage_events TO atelier_runtime;
    GRANT SELECT, INSERT, UPDATE ON control.tenants TO atelier_runtime;

    -- The audit log is append-only for the runtime role.
    GRANT SELECT, INSERT ON audit_log TO atelier_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM atelier_runtime;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO atelier_runtime;
    REVOKE ALL ON schema_migrations FROM atelier_runtime;
END
$$;
