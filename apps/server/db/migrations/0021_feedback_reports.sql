-- Reports about Atelier itself, for whoever runs it: a person saying something is
-- wrong or could be better, and the assistant saying what in the system got in
-- its way (ADR-0020). Like the audit log this looks across studios, so it is not
-- tenant-scoped; only operator routes read it. A report outlives its studio.
CREATE TABLE IF NOT EXISTS feedback_reports (
    id uuid PRIMARY KEY,
    -- 'person' or 'assistant'
    source text NOT NULL CHECK (source IN ('person', 'assistant')),
    -- person: 'problem' | 'idea'. assistant: 'tool' | 'rules' | 'missing' | 'other'.
    kind text NOT NULL,
    text text NOT NULL,
    -- Where it came from, as it was then: studio and website names, the page, the browser, the build.
    context jsonb NOT NULL DEFAULT '{}',
    tenant_id uuid,
    project_id uuid,
    user_id uuid,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS feedback_reports_recent ON feedback_reports (status, created_at DESC);
