-- Content studio (ADR-0014). Each document describes its fields: a label in the
-- person's words, a type and a line of help, so the editor shows proper fields
-- and never raw structure. Written by the assistant; null means "work it out
-- from the values" (documents from before this).
ALTER TABLE content_documents ADD COLUMN IF NOT EXISTS fields jsonb;
