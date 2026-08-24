import { z } from "zod";
import type { AppConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { AppError, publicProfile } from "./domain.js";
import { JiraClient } from "./jira-client.js";
import { ConfluenceClient } from "./confluence-client.js";
import { JiraProfileRepository, WorkspaceBindingRepository } from "./repositories.js";

export const sddEventTypes = [
  "PLAN_STARTED", "PLAN_BLOCKED", "PHASE_STARTED", "TASK_STARTED", "TASK_PROGRESS",
  "TASK_BLOCKED", "TASK_FAILED", "TASK_COMPLETED", "QA_STARTED", "QA_FAILED",
  "QA_PASSED", "BUILD_BLOCKED", "BUILD_COMPLETED",
] as const;
export type SddEventType = typeof sddEventTypes[number];
export type SddProgressInput = {
  eventKey: string;
  eventType: SddEventType;
  summary: string;
  targetStatus?: string;
  filesChanged?: string[];
  validations?: Array<{ command: string; status: "PASS" | "FAIL" | "SKIPPED"; summary?: string }>;
  blockers?: string[];
  nextStep?: string;
  phase?: "task" | "plan" | "build";
  runner?: "claude" | "ollama";
  model?: string;
  modelLabel?: string;
  executionId?: string;
};

export const profileInputSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  baseUrl: z.string().url().refine((url) => url.startsWith("https://"), "HTTPS is required"),
  email: z.string().email(),
  apiToken: z.string().min(8),
  defaultProjectKey: z.string().min(1).optional(),
  subtaskIssueType: z.string().min(1).optional(),
  statusAliases: z.record(z.string()).default({}),
  customFieldMap: z.record(z.string()).default({}),
});

export class JiraProfileService {
  constructor(
    private readonly profiles: JiraProfileRepository,
    private readonly credentials: CredentialStore,
    private readonly config: AppConfig,
  ) {}

  list() { return this.profiles.list().map(publicProfile); }

  get(id: string) {
    const profile = this.profiles.get(id);
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", `Jira profile ${id} not found`, 404);
    return publicProfile(profile);
  }

  async create(raw: unknown) {
    const input = profileInputSchema.parse(raw);
    const temporary = {
      ...input,
      credentialRef: "temporary",
      enabled: true,
      source: "runtime" as const,
      createdAt: "",
      updatedAt: "",
    };
    const client = new JiraClient(temporary, input.apiToken, this.config.attachmentMaxBytes);
    await client.myself();
    if (input.defaultProjectKey) await client.project(input.defaultProjectKey);
    const credentialRef = this.credentials.save(input.apiToken);
    try {
      return publicProfile(this.profiles.create({
        id: input.id, name: input.name, baseUrl: input.baseUrl, email: input.email,
        credentialRef, defaultProjectKey: input.defaultProjectKey,
        subtaskIssueType: input.subtaskIssueType, statusAliases: input.statusAliases,
        customFieldMap: input.customFieldMap,
      }));
    } catch (error) {
      this.credentials.delete(credentialRef);
      throw error;
    }
  }

  async test(id: string) {
    const client = this.client(id);
    const [user, projects] = await Promise.all([client.myself(), client.listProjects()]);
    return { ok: true, user, projects: projects.length };
  }

  async projects(id: string) { return this.client(id).listProjects(); }

  async metadata(id: string, projectKey?: string) {
    const profile = this.require(id);
    const key = projectKey ?? profile.defaultProjectKey;
    if (!key) throw new AppError("PROJECT_NOT_ACCESSIBLE", "A project key is required", 400);
    return this.client(id).metadata(key);
  }

  async update(id: string, raw: unknown) {
    const schema = profileInputSchema.omit({ id: true, apiToken: true }).partial();
    const patch = schema.parse(raw);
    const current = this.require(id);
    if (patch.baseUrl || patch.email || patch.defaultProjectKey) {
      const proposed = { ...current, ...patch };
      const client = new JiraClient(proposed, this.credentials.resolve(current.credentialRef), this.config.attachmentMaxBytes);
      await client.myself();
      if (proposed.defaultProjectKey) await client.project(proposed.defaultProjectKey);
    }
    return publicProfile(this.profiles.update(id, patch));
  }

  async rotateCredential(id: string, apiToken: string) {
    const profile = this.require(id);
    await new JiraClient(profile, apiToken, this.config.attachmentMaxBytes).myself();
    const nextRef = this.credentials.save(apiToken);
    const updated = this.profiles.update(id, { credentialRef: nextRef });
    this.credentials.delete(profile.credentialRef);
    return publicProfile(updated);
  }

  disable(id: string) { return publicProfile(this.profiles.update(id, { enabled: false })); }

  require(id: string) {
    const profile = this.profiles.get(id);
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", `Jira profile ${id} not found`, 404);
    if (!profile.enabled) throw new AppError("PROFILE_NOT_FOUND", `Jira profile ${id} is disabled`, 409);
    return profile;
  }

  client(id: string) {
    const profile = this.require(id);
    return new JiraClient(profile, this.credentials.resolve(profile.credentialRef), this.config.attachmentMaxBytes);
  }

  confluenceClient(id: string) {
    const profile = this.require(id);
    return new ConfluenceClient(profile, this.credentials.resolve(profile.credentialRef));
  }
}

export class WorkspaceService {
  constructor(
    private readonly bindings: WorkspaceBindingRepository,
    private readonly profiles: JiraProfileService,
  ) {}

  list() { return this.bindings.list(); }

  findOptional(workspacePath: string) { return this.bindings.findByPath(workspacePath); }

  resolve(workspacePath: string) {
    const binding = this.bindings.findByPath(workspacePath);
    if (!binding) throw new AppError("WORKSPACE_NOT_BOUND", "Workspace is not associated with a Jira profile", 409, { recommendedNextTool: "jira_bind_workspace" });
    this.profiles.require(binding.jiraProfileId);
    this.bindings.touch(binding.workspaceId);
    return binding;
  }

  async bind(workspacePath: string, jiraProfileId: string, jiraProjectKey: string) {
    await this.profiles.client(jiraProfileId).project(jiraProjectKey);
    return this.bindings.upsert(workspacePath, jiraProfileId, jiraProjectKey);
  }

  remove(workspaceId: string) {
    if (!this.bindings.remove(workspaceId)) throw new AppError("WORKSPACE_NOT_BOUND", "Workspace binding not found", 404);
    return { removed: true };
  }
}

export class ConfluenceService {
  constructor(
    private readonly profiles: JiraProfileService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private client(workspacePath: string) {
    const binding = this.workspaces.resolve(workspacePath);
    return this.profiles.confluenceClient(binding.jiraProfileId);
  }

  listSpaces(workspacePath: string, keys?: string[]) { return this.client(workspacePath).listSpaces(keys); }
  getPage(workspacePath: string, pageId: string) { return this.client(workspacePath).getPage(pageId); }

  async findPage(workspacePath: string, spaceKey: string, title: string) {
    const { spaceId, page } = await this.client(workspacePath).findPage(spaceKey, title);
    return { spaceId, exists: Boolean(page), page: page ?? null };
  }

  createPage(workspacePath: string, input: { spaceKey: string; title: string; body: string; parentId?: string; representation?: "storage" | "atlas_doc_format" | "wiki" }) {
    const client = this.client(workspacePath);
    return (async () => {
      const spaceId = await client.getSpaceIdByKey(input.spaceKey);
      return client.createPage({ spaceId, title: input.title, body: input.body, parentId: input.parentId, representation: input.representation });
    })();
  }

  updatePage(workspacePath: string, input: { pageId: string; title: string; body: string; representation?: "storage" | "atlas_doc_format" | "wiki"; versionMessage?: string }) {
    return this.client(workspacePath).updatePage(input);
  }
}

export class IssueService {
  constructor(
    private readonly profiles: JiraProfileService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private context(workspacePath: string) {
    const binding = this.workspaces.resolve(workspacePath);
    return { binding, client: this.profiles.client(binding.jiraProfileId) };
  }

  async get(workspacePath: string, issueKey: string) {
    const { issue } = await this.issueContext(workspacePath, issueKey);
    return issue;
  }
  createTask(workspacePath: string, input: { summary: string; description?: string; acceptanceCriteria?: string; issueType?: string; fields?: Record<string, unknown> }) {
    const { binding, client } = this.context(workspacePath);
    return client.createIssue({ projectKey: binding.jiraProjectKey, issueType: input.issueType ?? "Task", ...input });
  }
  async createSubtask(workspacePath: string, input: { parentIssueKey: string; summary: string; description?: string; acceptanceCriteria?: string; fields?: Record<string, unknown> }) {
    const { binding, client } = this.context(workspacePath);
    await this.assertProject(client, binding.jiraProjectKey, input.parentIssueKey);
    const profile = this.profiles.require(binding.jiraProfileId);
    return client.createIssue({ ...input, projectKey: binding.jiraProjectKey, issueType: profile.subtaskIssueType ?? "Subtask", parentIssueKey: input.parentIssueKey });
  }
  async edit(workspacePath: string, issueKey: string, input: { summary?: string; description?: string; acceptanceCriteria?: string; fields?: Record<string, unknown> }) { const { client } = await this.issueContext(workspacePath, issueKey); return client.editIssue(issueKey, input); }
  async linkIssues(workspacePath: string, issueKey: string, targetIssueKey: string, linkType?: string) { const { client } = await this.issueContext(workspacePath, issueKey); return client.linkIssues(issueKey, targetIssueKey, linkType); }
  async transitions(workspacePath: string, issueKey: string) { const { client } = await this.issueContext(workspacePath, issueKey); return client.transitions(issueKey); }
  async transition(workspacePath: string, issueKey: string, targetStatus: string) { const { client } = await this.issueContext(workspacePath, issueKey); return client.transition(issueKey, targetStatus); }
  async addComment(workspacePath: string, issueKey: string, body: string) { const { client } = await this.issueContext(workspacePath, issueKey); return client.addComment(issueKey, body); }
  async recordSddEvent(workspacePath: string, issueKey: string, input: SddProgressInput) {
    const { binding, client, issue } = await this.issueContext(workspacePath, issueKey);
    const propertyKey = "cloud.sdd.event";
    const existing = await client.findCommentByProperty(issueKey, propertyKey, input.eventKey);
    if (existing) {
      const property = existing.properties?.find((item) => item.key === propertyKey)?.value as Record<string, unknown> | undefined;
      return {
        issueKey, eventKey: input.eventKey, eventType: input.eventType, deduplicated: true,
        comment: { id: existing.id, created: existing.created }, transition: null,
        currentStatus: issue.fields?.status?.name, recordedAt: existing.created,
        report: property?.report,
      };
    }
    const transition = input.targetStatus ? await client.ensureTransition(issueKey, input.targetStatus) : null;
    const recordedAt = new Date().toISOString();
    const commentBody = renderSddProgressComment(input);
    const comment = await client.addComment(issueKey, commentBody, [{
      key: propertyKey,
      value: { eventKey: input.eventKey, eventType: input.eventType, recordedAt, execution: executionContext(input) },
    }]);
    return {
      issueKey, eventKey: input.eventKey, eventType: input.eventType, deduplicated: false,
      comment: { id: comment.id, created: comment.created },
      transition: transition ? { requested: transition.requested, targetStatus: transition.targetStatus, applied: transition.applied, noOp: transition.noOp } : null,
      recordedAt,
    };
  }

  async attachments(workspacePath: string, issueKey: string) { const { client, issue } = await this.issueContext(workspacePath, issueKey); return issue.fields?.attachment ?? client.listAttachments(issueKey); }
  async addAttachment(workspacePath: string, issueKey: string, fileName: string, mimeType: string, dataBase64: string) {
    const { client } = await this.issueContext(workspacePath, issueKey);
    const content = Buffer.from(dataBase64, "base64");
    if (!content.length || content.toString("base64").replace(/=+$/, "") !== dataBase64.replace(/\s+/g, "").replace(/=+$/, "")) {
      throw new AppError("FIELD_VALIDATION_FAILED", "Attachment dataBase64 is invalid", 400);
    }
    return client.uploadAttachment(issueKey, fileName, content, mimeType);
  }
  async readAttachment(workspacePath: string, issueKey: string, attachmentId: string, maxBytes?: number) { const { client } = await this.issueContext(workspacePath, issueKey); return client.readAttachment(issueKey, attachmentId, maxBytes); }

  private async issueContext(workspacePath: string, issueKey: string) {
    const { binding, client } = this.context(workspacePath);
    const issue = await this.assertProject(client, binding.jiraProjectKey, issueKey);
    return { binding, client, issue };
  }

  private async assertProject(client: JiraClient, expectedProjectKey: string, issueKey: string) {
    const issue = await client.getIssue(issueKey);
    const actualProjectKey = issue.fields?.project?.key;
    if (actualProjectKey !== expectedProjectKey) {
      throw new AppError("ISSUE_OUTSIDE_BOUND_PROJECT", `Issue ${issueKey} belongs to project ${actualProjectKey ?? "unknown"}, not ${expectedProjectKey}`, 403);
    }
    return issue;
  }


}

export function renderSddProgressComment(input: SddProgressInput) {
  const lines = [`SDD ${input.eventType}: ${input.summary}`];
  const execution = renderExecutionContext(input);
  if (execution) lines.push(`Execucao: ${execution}`);
  if (input.filesChanged?.length) lines.push("", "Arquivos alterados:", ...input.filesChanged.map((item) => `- ${item}`));
  if (input.validations?.length) lines.push("", "Validacoes:", ...input.validations.map((item) => `- [${item.status}] ${item.command}${item.summary ? `: ${item.summary}` : ""}`));
  if (input.blockers?.length) lines.push("", "Bloqueios:", ...input.blockers.map((item) => `- ${item}`));
  if (input.nextStep) lines.push("", `Proximo passo: ${input.nextStep}`);
  return lines.join("\n");
}

function executionContext(input: SddProgressInput) {
  if (!input.runner && !input.model && !input.phase && !input.executionId) return undefined;
  return { phase: input.phase, runner: input.runner, model: input.model, modelLabel: input.modelLabel, executionId: input.executionId };
}
function renderExecutionContext(input: SddProgressInput) {
  if (!input.runner && !input.model && !input.phase) return "";
  const runner = input.runner === "ollama" ? "Ollama" : input.runner === "claude" ? "Claude" : "Runner desconhecido";
  const phase = input.phase === "task" ? "Tarefa" : input.phase === "plan" ? "Planejamento" : input.phase === "build" ? "Execucao" : undefined;
  return [runner, input.modelLabel || input.model, phase].filter(Boolean).join(" · ");
}
