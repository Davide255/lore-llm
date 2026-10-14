-- What kind of client an agent is (shown with its own identity in the apps).
-- Add-only: existing agents become 'claude', the only kind used before this.
ALTER TABLE permissions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude';
