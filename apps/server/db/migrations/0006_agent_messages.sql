-- The conversation with the assistant is project data: it must follow the
-- project across browsers and devices, not live in one browser's storage.
-- A user message records the run it started; the reply is stored once, when the
-- run settles (the partial unique index makes that idempotent under polling).
CREATE TABLE IF NOT EXISTS agent_messages (
    seq bigserial PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    session_id uuid,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'error')),
    body text NOT NULL,
    tools jsonb,
    run_id uuid,
    author_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_messages_project_idx ON agent_messages (project_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_one_per_run_role ON agent_messages (run_id, (role = 'user')) WHERE run_id IS NOT NULL;

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_agent_messages ON agent_messages
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
