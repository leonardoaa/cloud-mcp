import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jira_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      default_project_key TEXT,
      subtask_issue_type TEXT,
      status_aliases_json TEXT NOT NULL DEFAULT '{}',
      custom_field_map_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL CHECK (source IN ('bootstrap', 'runtime')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jira_credentials (
      id TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_bindings (
      workspace_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      workspace_name TEXT,
      jira_profile_id TEXT NOT NULL,
      jira_project_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      FOREIGN KEY (jira_profile_id) REFERENCES jira_profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_bindings_profile
      ON workspace_bindings (jira_profile_id, jira_project_key);

    CREATE TABLE IF NOT EXISTS mcp_call_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      protocol_method TEXT NOT NULL,
      target_name TEXT,
      operation_kind TEXT NOT NULL,
      client_name TEXT,
      client_version TEXT,
      session_fingerprint TEXT,
      workspace_id TEXT,
      jira_profile_id TEXT,
      jira_project_key TEXT,
      issue_key TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL,
      error_code TEXT,
      safe_summary_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_received
      ON mcp_call_logs (received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_filter
      ON mcp_call_logs (target_name, outcome, jira_profile_id, received_at DESC);

    CREATE TABLE IF NOT EXISTS sdd_previews (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sdd_previews_expiry ON sdd_previews (expires_at);
  `);
}
