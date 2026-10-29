-- Hardening after a review of the schema. Nothing here changes or removes a row, and
-- every write the server makes today (store/postgres.ts) is still allowed: the rules
-- below only refuse what the server never does.

-- ---- invitations ------------------------------------------------------------------
-- The one policy from 0007 covered every command, so whoever an invitation was
-- addressed to could also write one: an invitation for their own address into any
-- studio, as admin, which the memberships policy then honoured. The invited person
-- needs to see their invitations and mark them accepted (services/bootstrap.ts,
-- acceptInvitations), and nothing else. Writing and removing them is the studio's.
DROP POLICY IF EXISTS tenant_or_invitee_invitations ON invitations;
DROP POLICY IF EXISTS invitations_read ON invitations;
CREATE POLICY invitations_read ON invitations FOR SELECT
    USING (tenant_id = app_current_tenant() OR email = app_current_email());
DROP POLICY IF EXISTS invitations_tenant_insert ON invitations;
CREATE POLICY invitations_tenant_insert ON invitations FOR INSERT
    WITH CHECK (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS invitations_update ON invitations;
CREATE POLICY invitations_update ON invitations FOR UPDATE
    USING (tenant_id = app_current_tenant() OR email = app_current_email())
    WITH CHECK (tenant_id = app_current_tenant() OR email = app_current_email());
DROP POLICY IF EXISTS invitations_tenant_delete ON invitations;
CREATE POLICY invitations_tenant_delete ON invitations FOR DELETE
    USING (tenant_id = app_current_tenant());

-- A policy cannot compare a row with what it was, so this does: outside the
-- invitation's own studio, the only change allowed is accepting it, once.
-- (`invited_by` is left out: it is cleared when the person who invited is deleted.)
CREATE OR REPLACE FUNCTION invitations_accept_only() RETURNS trigger AS $$
BEGIN
    IF OLD.tenant_id IS DISTINCT FROM app_current_tenant() AND (
        (NEW.id, NEW.tenant_id, NEW.email, NEW.role, NEW.expires_at)
            IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.email, OLD.role, OLD.expires_at)
        OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
    ) THEN
        RAISE EXCEPTION 'an invitation can be changed by only its studio' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS invitations_accept_only ON invitations;
CREATE TRIGGER invitations_accept_only BEFORE UPDATE ON invitations
    FOR EACH ROW EXECUTE FUNCTION invitations_accept_only();

-- ---- memberships ------------------------------------------------------------------
-- The same, for the policy from 0007: a person sees their own memberships (that is
-- how sign-in finds their studios) and may join where a live invitation says so.
-- Changing a role and removing a member are done as the studio.
DROP POLICY IF EXISTS tenant_or_self_memberships ON memberships;
DROP POLICY IF EXISTS memberships_read ON memberships;
CREATE POLICY memberships_read ON memberships FOR SELECT
    USING (tenant_id = app_current_tenant() OR user_id = app_current_user());
DROP POLICY IF EXISTS memberships_insert ON memberships;
CREATE POLICY memberships_insert ON memberships FOR INSERT
    WITH CHECK (
        tenant_id = app_current_tenant()
        OR (
            user_id = app_current_user()
            AND EXISTS (
                SELECT 1 FROM invitations i
                WHERE i.tenant_id = memberships.tenant_id AND i.email = app_current_email()
                  AND i.role = memberships.role AND i.accepted_at IS NULL AND i.expires_at > now()
            )
        )
    );
DROP POLICY IF EXISTS memberships_tenant_update ON memberships;
CREATE POLICY memberships_tenant_update ON memberships FOR UPDATE
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS memberships_tenant_delete ON memberships;
CREATE POLICY memberships_tenant_delete ON memberships FOR DELETE
    USING (tenant_id = app_current_tenant());

-- ---- the list of studios ------------------------------------------------------------
-- control.tenants is read across studios (the operator's list), but each entry is
-- only ever written together with its studio, inside that studio's transaction.
-- So that is what the database allows: a mistake made as one studio cannot rename,
-- suspend or remove another's entry.
ALTER TABLE control.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_read ON control.tenants;
CREATE POLICY tenants_read ON control.tenants FOR SELECT USING (true);
DROP POLICY IF EXISTS tenants_own_insert ON control.tenants;
CREATE POLICY tenants_own_insert ON control.tenants FOR INSERT
    WITH CHECK (id = app_current_tenant());
DROP POLICY IF EXISTS tenants_own_update ON control.tenants;
CREATE POLICY tenants_own_update ON control.tenants FOR UPDATE
    USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
DROP POLICY IF EXISTS tenants_own_delete ON control.tenants;
CREATE POLICY tenants_own_delete ON control.tenants FOR DELETE
    USING (id = app_current_tenant());

-- ---- custom domains -----------------------------------------------------------------
-- "One website per hostname" compares text, and a hostname does not care about case.
-- The server lowers it before storing (services/hosting.ts); the database now insists.
-- NOT VALID: rows already here are left as they are, new ones are checked.
ALTER TABLE project_domains DROP CONSTRAINT IF EXISTS project_domains_hostname_lower;
ALTER TABLE project_domains ADD CONSTRAINT project_domains_hostname_lower CHECK (hostname = lower(hostname)) NOT VALID;

-- ---- indexes ------------------------------------------------------------------------
-- Postgres does not index the referencing side of a foreign key. These are the ones
-- that were missing: without them, deleting a website (or a studio) reads each of
-- these tables from end to end for every row that goes, and so do the per-website lists.
CREATE INDEX IF NOT EXISTS deployments_project ON deployments (project_id, created_at);
CREATE INDEX IF NOT EXISTS deployments_release ON deployments (release_id) WHERE release_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_project ON agent_sessions (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS content_revisions_project ON content_revisions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS release_documents_document ON release_documents (document_id);
CREATE INDEX IF NOT EXISTS release_documents_project ON release_documents (project_id);
