-- The assistant asks the person before it guesses (ADR-0019).
-- How much it asks is a setting of the website: 0 decides everything itself,
-- 1 asks only when it matters, 2 checks before big choices, 3 assumes nothing.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ask_level smallint NOT NULL DEFAULT 1 CHECK (ask_level BETWEEN 0 AND 3);

-- What it asked, and what it was told. One set of questions is open per website at a time.
CREATE TABLE IF NOT EXISTS agent_questions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    session_id uuid,
    -- [{ question, why, options: [..] }]
    questions jsonb NOT NULL,
    -- One answer per question once answered; null while open or when set aside unanswered.
    answers jsonb,
    asked_at timestamptz NOT NULL DEFAULT now(),
    -- When it stopped being open: answered, or set aside by a new request.
    closed_at timestamptz,
    answered_by uuid,
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_questions_project ON agent_questions (project_id, asked_at DESC);
ALTER TABLE agent_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_agent_questions ON agent_questions;
CREATE POLICY tenant_agent_questions ON agent_questions
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
