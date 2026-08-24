import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { BootstrapProfile } from "./config.js";
import type { SqliteDatabase } from "./database.js";
import type { JiraProfile, McpCallLog, WorkspaceBinding } from "./domain.js";
import { AppError } from "./domain.js";

type ProfileRow = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  credential_ref: string;
  default_project_key: string | null;
  subtask_issue_type: string | null;
  status_aliases_json: string;
  custom_field_map_json: string;
  enabled: number;
  source: "bootstrap" | "runtime";
  created_at: string;
  updated_at: string;
};

export class JiraProfileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  importBootstrap(profiles: BootstrapProfile[]) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO jira_profiles (
        id, name, base_url, email, credential_ref, default_project_key,
        subtask_issue_type, status_aliases_json, custom_field_map_json,
        enabled, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'bootstrap', ?, ?)
    `);
    const transaction = this.db.transaction(() => {
      for (const profile of profiles) {
        const now = new Date().toISOString();
        insert.run(
          profile.id,
          profile.name,
          normalizeBaseUrl(profile.baseUrl),
          profile.email,
          `env:${profile.apiTokenEnv}`,
          profile.defaultProjectKey ?? null,
          profile.subtaskIssueType ?? null,
          JSON.stringify(profile.statusAliases),
          JSON.stringify(profile.customFieldMap),
          now,
          now,
        );
      }
    });
    transaction();
  }

  list(includeDisabled = true): JiraProfile[] {
    const sql = includeDisabled
      ? "SELECT * FROM jira_profiles ORDER BY name COLLATE NOCASE"
      : "SELECT * FROM jira_profiles WHERE enabled = 1 ORDER BY name COLLATE NOCASE";
    return (this.db.prepare(sql).all() as ProfileRow[]).map(mapProfile);
  }

  get(id: string): JiraProfile | undefined {
    const row = this.db.prepare("SELECT * FROM jira_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
    return row ? mapProfile(row) : undefined;
  }

  create(input: Omit<JiraProfile, "createdAt" | "updatedAt" | "source" | "enabled">): JiraProfile {
    if (this.get(input.id)) throw new AppError("PROFILE_ALREADY_EXISTS", `Jira profile ${input.id} already exists`, 409);
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO jira_profiles (
          id, name, base_url, email, credential_ref, default_project_key,
          subtask_issue_type, status_aliases_json, custom_field_map_json,
          enabled, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'runtime', ?, ?)
      `).run(
        input.id,
        input.name,
        normalizeBaseUrl(input.baseUrl),
        input.email,
        input.credentialRef,
        input.defaultProjectKey ?? null,
        input.subtaskIssueType ?? null,
        JSON.stringify(input.statusAliases),
        JSON.stringify(input.customFieldMap),
        now,
        now,
      );
    } catch (error) {
      throw new AppError("PROFILE_ALREADY_EXISTS", "A Jira profile with this ID or URL already exists", 409, error);
    }
    return this.get(input.id)!;
  }

  update(id: string, patch: Partial<Omit<JiraProfile, "id" | "createdAt" | "source">>): JiraProfile {
    const current = this.get(id);
    if (!current) throw new AppError("PROFILE_NOT_FOUND", `Jira profile ${id} not found`, 404);
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      UPDATE jira_profiles SET name = ?, base_url = ?, email = ?, credential_ref = ?,
        default_project_key = ?, subtask_issue_type = ?, status_aliases_json = ?,
        custom_field_map_json = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(
      next.name,
      normalizeBaseUrl(next.baseUrl),
      next.email,
      next.credentialRef,
      next.defaultProjectKey ?? null,
      next.subtaskIssueType ?? null,
      JSON.stringify(next.statusAliases),
      JSON.stringify(next.customFieldMap),
      next.enabled ? 1 : 0,
      next.updatedAt,
      id,
    );
    return this.get(id)!;
  }
}

export class WorkspaceBindingRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): WorkspaceBinding[] {
    return (this.db.prepare("SELECT * FROM workspace_bindings ORDER BY last_used_at DESC").all() as BindingRow[]).map(mapBinding);
  }

  get(workspaceId: string): WorkspaceBinding | undefined {
    const row = this.db.prepare("SELECT * FROM workspace_bindings WHERE workspace_id = ?").get(workspaceId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  findByPath(path: string): WorkspaceBinding | undefined {
    return this.get(workspaceIdentity(path).id);
  }

  upsert(path: string, jiraProfileId: string, jiraProjectKey: string, workspaceName?: string): WorkspaceBinding {
    const identity = workspaceIdentity(path);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_bindings (
        workspace_id, canonical_path, workspace_name, jira_profile_id,
        jira_project_key, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        workspace_name = excluded.workspace_name,
        jira_profile_id = excluded.jira_profile_id,
        jira_project_key = excluded.jira_project_key,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `).run(identity.id, identity.path, workspaceName ?? basename(identity.path), jiraProfileId, jiraProjectKey, now, now, now);
    return this.get(identity.id)!;
  }

  touch(workspaceId: string) {
    this.db.prepare("UPDATE workspace_bindings SET last_used_at = ? WHERE workspace_id = ?").run(new Date().toISOString(), workspaceId);
  }

  remove(workspaceId: string): boolean {
    return this.db.prepare("DELETE FROM workspace_bindings WHERE workspace_id = ?").run(workspaceId).changes > 0;
  }
}

export class CallLogRepository {
  private listeners = new Set<(log: McpCallLog) => void>();

  constructor(private readonly db: SqliteDatabase) {}

  start(input: Pick<McpCallLog, "requestId" | "protocolMethod" | "targetName" | "operationKind" | "safeSummary">): McpCallLog {
    const log: McpCallLog = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      outcome: "running",
      ...input,
    };
    this.db.prepare(`
      INSERT INTO mcp_call_logs (
        id, request_id, received_at, protocol_method, target_name,
        operation_kind, outcome, safe_summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(log.id, log.requestId, log.receivedAt, log.protocolMethod, log.targetName ?? null, log.operationKind, log.outcome, JSON.stringify(log.safeSummary));
    this.emit(log);
    return log;
  }

  finish(id: string, outcome: McpCallLog["outcome"], httpStatus: number, errorCode?: string) {
    const current = this.get(id);
    if (!current) return;
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(current.receivedAt));
    this.db.prepare(`
      UPDATE mcp_call_logs SET completed_at = ?, duration_ms = ?, outcome = ?,
        http_status = ?, error_code = ? WHERE id = ?
    `).run(completedAt, durationMs, outcome, httpStatus, errorCode ?? null, id);
    this.emit(this.get(id)!);
  }

  get(id: string): McpCallLog | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_call_logs WHERE id = ?").get(id) as CallLogRow | undefined;
    return row ? mapCallLog(row) : undefined;
  }

  list(filters: { targetName?: string; outcome?: string; limit?: number; before?: string } = {}) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.targetName) { clauses.push("target_name = ?"); params.push(filters.targetName); }
    if (filters.outcome) { clauses.push("outcome = ?"); params.push(filters.outcome); }
    if (filters.before) { clauses.push("received_at < ?"); params.push(filters.before); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(filters.limit ?? 100, 200));
    return (this.db.prepare(`SELECT * FROM mcp_call_logs ${where} ORDER BY received_at DESC, id DESC LIMIT ?`).all(...params) as CallLogRow[]).map(mapCallLog);
  }

  retain(days: number, maxRows: number) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM mcp_call_logs WHERE received_at < ?").run(cutoff);
    this.db.prepare(`
      DELETE FROM mcp_call_logs WHERE id IN (
        SELECT id FROM mcp_call_logs ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?
      )
    `).run(maxRows);
  }

  subscribe(listener: (log: McpCallLog) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(log: McpCallLog) {
    for (const listener of this.listeners) listener(log);
  }
}

export function workspaceIdentity(input: string) {
  let canonical: string;
  try { canonical = realpathSync(resolve(input)); } catch { canonical = resolve(input); }
  canonical = canonical.replace(/\/$/, "");
  return { path: canonical, id: createHash("sha256").update(canonical).digest("hex") };
}

function normalizeBaseUrl(value: string) { return value.replace(/\/+$/, ""); }

function mapProfile(row: ProfileRow): JiraProfile {
  return {
    id: row.id, name: row.name, baseUrl: row.base_url, email: row.email,
    credentialRef: row.credential_ref, defaultProjectKey: row.default_project_key ?? undefined,
    subtaskIssueType: row.subtask_issue_type ?? undefined,
    statusAliases: JSON.parse(row.status_aliases_json), customFieldMap: JSON.parse(row.custom_field_map_json),
    enabled: Boolean(row.enabled), source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

type BindingRow = { workspace_id: string; canonical_path: string; workspace_name: string | null; jira_profile_id: string; jira_project_key: string; created_at: string; updated_at: string; last_used_at: string };
function mapBinding(row: BindingRow): WorkspaceBinding {
  return { workspaceId: row.workspace_id, canonicalPath: row.canonical_path, workspaceName: row.workspace_name ?? undefined, jiraProfileId: row.jira_profile_id, jiraProjectKey: row.jira_project_key, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at };
}

type CallLogRow = { id: string; request_id: string; received_at: string; completed_at: string | null; duration_ms: number | null; protocol_method: string; target_name: string | null; operation_kind: string; client_name: string | null; client_version: string | null; session_fingerprint: string | null; workspace_id: string | null; jira_profile_id: string | null; jira_project_key: string | null; issue_key: string | null; http_status: number | null; outcome: McpCallLog["outcome"]; error_code: string | null; safe_summary_json: string };
function mapCallLog(row: CallLogRow): McpCallLog {
  return { id: row.id, requestId: row.request_id, receivedAt: row.received_at, completedAt: row.completed_at ?? undefined, durationMs: row.duration_ms ?? undefined, protocolMethod: row.protocol_method, targetName: row.target_name ?? undefined, operationKind: row.operation_kind, clientName: row.client_name ?? undefined, clientVersion: row.client_version ?? undefined, sessionFingerprint: row.session_fingerprint ?? undefined, workspaceId: row.workspace_id ?? undefined, jiraProfileId: row.jira_profile_id ?? undefined, jiraProjectKey: row.jira_project_key ?? undefined, issueKey: row.issue_key ?? undefined, httpStatus: row.http_status ?? undefined, outcome: row.outcome, errorCode: row.error_code ?? undefined, safeSummary: JSON.parse(row.safe_summary_json) };
}
