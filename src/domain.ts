export type JiraProfile = {
  id: string;
  name: string;
  baseUrl: string;
  email: string;
  credentialRef: string;
  defaultProjectKey?: string;
  subtaskIssueType?: string;
  statusAliases: Record<string, string>;
  customFieldMap: Record<string, string>;
  enabled: boolean;
  source: "bootstrap" | "runtime";
  createdAt: string;
  updatedAt: string;
};

export type PublicJiraProfile = Omit<JiraProfile, "credentialRef"> & {
  emailMasked: string;
};

export type WorkspaceBinding = {
  workspaceId: string;
  canonicalPath: string;
  workspaceName?: string;
  jiraProfileId: string;
  jiraProjectKey: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

export type McpCallLog = {
  id: string;
  requestId: string;
  receivedAt: string;
  completedAt?: string;
  durationMs?: number;
  protocolMethod: string;
  targetName?: string;
  operationKind: string;
  clientName?: string;
  clientVersion?: string;
  sessionFingerprint?: string;
  workspaceId?: string;
  jiraProfileId?: string;
  jiraProjectKey?: string;
  issueKey?: string;
  httpStatus?: number;
  outcome: "received" | "running" | "success" | "error" | "cancelled";
  errorCode?: string;
  safeSummary: Record<string, unknown>;
};

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function publicProfile(profile: JiraProfile): PublicJiraProfile {
  const { credentialRef: _credentialRef, ...safe } = profile;
  return { ...safe, emailMasked: maskEmail(profile.email) };
}
