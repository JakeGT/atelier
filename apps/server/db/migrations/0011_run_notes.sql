-- A run that was stopped, or ran out of time, leaves a "note" in the
-- conversation: not a reply and not an error, and it can be carried on from.
ALTER TABLE agent_messages DROP CONSTRAINT IF EXISTS agent_messages_role_check;
ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_role_check CHECK (role IN ('user', 'assistant', 'error', 'note'));
