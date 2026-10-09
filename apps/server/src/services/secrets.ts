import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Sealing for secrets stored in the database (provider API keys). AES-256-GCM
// under a key derived from ATELIER_SECRETS_KEY, with the secret's "address"
// (tenant + name) as additional authenticated data: a sealed value copied to
// another tenant's row, or another provider's, does not open (docs/11 §6).
// The plaintext exists only in memory, only while a request is being forwarded.

const VERSION = "v1";

export class SecretBox {
    private readonly key: Buffer;

    constructor(secretsKey: string) {
        this.key = Buffer.from(hkdfSync("sha256", secretsKey, "atelier", "stored-secrets:v1", 32));
    }

    seal(plaintext: string, address: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(address));
        const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    }

    // Returns null if the value was tampered with, belongs elsewhere, or was sealed under another key.
    open(sealed: string, address: string): string | null {
        const [version, iv, tag, body] = sealed.split(".");
        if (version !== VERSION || !iv || !tag || body === undefined) return null;
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
            decipher.setAAD(Buffer.from(address));
            decipher.setAuthTag(Buffer.from(tag, "base64url"));
            return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
        } catch {
            return null;
        }
    }
}

export const providerKeyAddress = (tenantId: string, provider: string): string => `tenant:${tenantId}:provider-key:${provider}`;
