-- BYOK (ADR-0011): a studio's own API keys for model providers. The key is stored
-- sealed (AES-256-GCM, bound to this tenant and provider); `hint` is its last four
-- characters, for the person to recognise it by. It is never returned by the API
-- and never sent to a workspace.
CREATE TABLE IF NOT EXISTS provider_keys (
    tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider text NOT NULL,
    sealed text NOT NULL,
    hint text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider)
);
ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_provider_keys ON provider_keys
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
