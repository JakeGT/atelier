-- What visitors send through a website's forms (a contact form, a sign-up box).
-- Written by the public form endpoint for the website a signed link names; read
-- by the studio's people. Rows go with their website.
CREATE TABLE IF NOT EXISTS form_submissions (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    -- The form's name in the page ("contact", "signup").
    form text NOT NULL,
    -- What was sent: field name -> text.
    data jsonb NOT NULL,
    -- Sent from the private preview while the form was being tried, not by a visitor.
    preview boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS form_submissions_project ON form_submissions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS form_submissions_tenant_time ON form_submissions (tenant_id, created_at);
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_form_submissions ON form_submissions;
CREATE POLICY tenant_form_submissions ON form_submissions
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
