-- P2: organisations people can share, project management, per-project agent
-- settings, and metering. Everything here is additive.

-- ---- organisations: settings and limits -------------------------------------------
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_model text;
-- Limits are safety ceilings (billing is BYOK): NULL means "use the server default".
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_projects integer;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS daily_token_limit bigint;

-- ---- invitations ------------------------------------------------------------------
-- An invitation is addressed to an e-mail. It is accepted the next time someone
-- signs in with that (provider-verified) address: there is no mail to send and no
-- token to leak. It is visible to its organisation, and to the invited address.
CREATE OR REPLACE FUNCTION app_current_email() RETURNS text AS $$
    SELECT NULLIF(lower(current_setting('app.current_email', true)), '');
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS invitations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email text NOT NULL CHECK (email = lower(email)),
    role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (email) WHERE accepted_at IS NULL;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_invitee_invitations ON invitations
    USING (tenant_id = app_current_tenant() OR email = app_current_email())
    WITH CHECK (tenant_id = app_current_tenant() OR email = app_current_email());

-- Accepting an invitation creates the membership while only the *user* is known
-- (no tenant is selected yet at sign-in), so a membership row may also be
-- inserted by its own user when a live invitation for their address exists.
DROP POLICY IF EXISTS tenant_or_self_memberships ON memberships;
CREATE POLICY tenant_or_self_memberships ON memberships
    USING (tenant_id = app_current_tenant() OR user_id = app_current_user())
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

-- Members are listed by organisation.
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- ---- projects: lifecycle and agent settings -----------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_instructions text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_model text;

-- ---- metering -----------------------------------------------------------------------
-- One row per (kind, source): recording a run's usage twice is a no-op.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source_id text;
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_once ON usage_events (tenant_id, kind, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_events_period_idx ON usage_events (tenant_id, occurred_at);
