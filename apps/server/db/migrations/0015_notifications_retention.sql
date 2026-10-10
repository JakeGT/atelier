-- Things a person should know about when they are not looking (E5.3): shown in
-- the app, and e-mailed if they want that. A notification belongs to one person;
-- only they can read it.
CREATE TABLE IF NOT EXISTS notifications (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id uuid,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    -- A path in the app to go and look.
    link text,
    -- The same event is told to a person once.
    dedupe text,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    emailed_at timestamptz,
    UNIQUE (user_id, dedupe)
);
CREATE INDEX IF NOT EXISTS notifications_user_recent ON notifications (user_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_notifications ON notifications;
CREATE POLICY own_notifications ON notifications
    USING (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications boolean NOT NULL DEFAULT true;

-- Retention (E5.2) looks things up by age.
CREATE INDEX IF NOT EXISTS agent_messages_created ON agent_messages (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS content_revisions_created ON content_revisions (tenant_id, created_at);
