-- The assistant remembers the conversation. `conversation_at`: when the person last chose to
-- start a new one (null: never); what was said before it is not carried into a request.
-- `changes_seen`: how many of Atelier's own changes (services/changes.ts) the assistant has
-- been told about on this website, so each is told once.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS conversation_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS changes_seen integer NOT NULL DEFAULT 0;
