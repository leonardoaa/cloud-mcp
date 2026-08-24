let csrfToken = "";

export function setCsrf(value: string) { csrfToken = value; }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.method && options.method !== "GET" ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type JiraProfile = {
  id: string; name: string; baseUrl: string; email: string; emailMasked: string;
  defaultProjectKey?: string; subtaskIssueType?: string; enabled: boolean; source: string;
  statusAliases: Record<string, string>; customFieldMap: Record<string, string>;
};

export type WorkspaceBinding = {
  workspaceId: string; canonicalPath: string; workspaceName?: string;
  jiraProfileId: string; jiraProjectKey: string; lastUsedAt: string;
};

export type CallLog = {
  id: string; requestId: string; receivedAt: string; durationMs?: number;
  protocolMethod: string; targetName?: string; outcome: string; httpStatus?: number;
  errorCode?: string; safeSummary: Record<string, unknown>;
};

export type SddCardColumn = "sdd-task" | "planning" | "sdd-build" | "blocked" | "done";
export type SddCommandKind = "sdd-task" | "sdd-plan" | "sdd-build";

export type SddRunnerProfile = {
  id: "claude-default" | "claude-admin" | "claude-ollama-kimi";
  label: string;
  command: string;
  args: string[];
  requiresStrongConfirmation: boolean;
};

export type SddTerminalSession = {
  id: string;
  cardId: string;
  workspaceId: string;
  commandKind: SddCommandKind;
  commandText: string;
  runnerProfileId: SddRunnerProfile["id"];
  runnerLabel: string;
  commandExecutable: string;
  args: string[];
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  logTail: string;
};

export type SddCard = {
  id: string;
  workspaceId: string;
  title: string;
  requestText: string;
  column: SddCardColumn;
  status: "idle" | "running" | "blocked" | "done";
  jiraIssueKey?: string;
  runnerProfileId: SddRunnerProfile["id"];
  createdAt: string;
  updatedAt: string;
  sessions?: SddTerminalSession[];
};
