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
    GRANT EXECUTE ON FUNCTION public.app_current_tenant(), public.app_current_user(), public.app_current_email() TO atelier_runtime;

    -- Tenant-scoped tables: row-level security applies to the runtime role.
    GRANT SELECT, INSERT, UPDATE, DELETE ON
        organizations, memberships, projects, content_documents, content_revisions,
        media_assets, releases, release_documents, deployments, agent_sessions, agent_messages,
        invitations, provider_keys, project_domains, notifications, project_members, studio_templates, form_submissions, agent_questions
        TO atelier_runtime;
    -- Who people are, and their sign-ins. These are not tenant-scoped and carry no
    -- row-level security: someone is looked up by identity, and a sign-in by its
    -- cookie, before anything else about the request is known.
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO atelier_runtime;
    -- The server never deletes a person (which would take their sign-ins and memberships along).
    GRANT SELECT, INSERT, UPDATE ON users TO atelier_runtime;
    REVOKE DELETE, TRUNCATE ON users FROM atelier_runtime;
    GRANT SELECT, INSERT ON usage_events TO atelier_runtime;
    -- The list of studios. Read across studios; each entry is written only inside its
    -- own studio's transaction (the policies in 0025). DELETE: a studio that is
    -- deleted leaves the operator's list too.
    GRANT SELECT, INSERT, UPDATE, DELETE ON control.tenants TO atelier_runtime;

    -- The audit log is append-only for the runtime role.
    GRANT SELECT, INSERT ON audit_log TO atelier_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM atelier_runtime;

    -- Operators' visits to studios: started, ended and read by operator code only.
    GRANT SELECT, INSERT, UPDATE, DELETE ON operator_visits TO atelier_runtime;

    -- Reports about Atelier itself: written by anyone, read and closed by operator routes.
    GRANT SELECT, INSERT, UPDATE ON feedback_reports TO atelier_runtime;
    REVOKE DELETE, TRUNCATE ON feedback_reports FROM atelier_runtime;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO atelier_runtime;
    REVOKE ALL ON schema_migrations FROM atelier_runtime;
END
$$;
