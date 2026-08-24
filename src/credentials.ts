import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";
import { AppError } from "./domain.js";

export class CredentialStore {
  private readonly key?: Buffer;

  constructor(
    private readonly db: SqliteDatabase,
    masterKey?: string,
  ) {
    this.key = masterKey ? deriveKey(masterKey) : undefined;
  }

  save(secret: string): string {
    if (!this.key) throw new AppError("CREDENTIAL_INPUT_REQUIRED", "JIRA_CREDENTIALS_MASTER_KEY is not configured", 503);
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.db.prepare(`
      INSERT INTO jira_credentials (id, ciphertext, iv, auth_tag, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, ciphertext, iv, authTag, new Date().toISOString());
    return `sqlite:${id}`;
  }

  resolve(reference: string): string {
    if (reference.startsWith("env:")) {
      const name = reference.slice(4);
      const value = process.env[name];
      if (!value) throw new AppError("JIRA_AUTH_FAILED", `Credential environment variable ${name} is unavailable`, 503);
      return value;
    }
    if (!reference.startsWith("sqlite:") || !this.key) {
      throw new AppError("JIRA_AUTH_FAILED", "Credential cannot be resolved", 503);
    }
    const row = this.db.prepare("SELECT ciphertext, iv, auth_tag FROM jira_credentials WHERE id = ?").get(reference.slice(7)) as
      | { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }
      | undefined;
    if (!row) throw new AppError("JIRA_AUTH_FAILED", "Credential not found", 503);
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }

  delete(reference: string) {
    if (reference.startsWith("sqlite:")) {
      this.db.prepare("DELETE FROM jira_credentials WHERE id = ?").run(reference.slice(7));
    }
  }
}

function deriveKey(value: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to a deterministic digest for local development.
  }
  return createHash("sha256").update(value).digest();
}
