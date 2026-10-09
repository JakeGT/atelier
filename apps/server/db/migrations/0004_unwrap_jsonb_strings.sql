-- Repair double-encoded content. Before this fix the Postgres store wrote
-- `${JSON.stringify(draft)}::jsonb`, which postgres.js sends as a JSON *string*,
-- so drafts were stored as jsonb string scalars ("{\"title\":…}") rather than
-- objects. Drafts are always objects (the API rejects anything else), so any
-- string-typed value here is a wrapped object: unwrap it.
--
-- Runs as the table owner under FORCE ROW LEVEL SECURITY, so lift RLS on this
-- table for the length of the migration transaction only.
ALTER TABLE content_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_documents DISABLE ROW LEVEL SECURITY;

UPDATE content_documents SET draft = (draft #>> '{}')::jsonb WHERE jsonb_typeof(draft) = 'string';
UPDATE content_documents SET published = (published #>> '{}')::jsonb WHERE jsonb_typeof(published) = 'string';

ALTER TABLE content_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_documents FORCE ROW LEVEL SECURITY;
