import type { JiraProfile } from "./domain.js";
import { AppError } from "./domain.js";

type FetchOptions = RequestInit & { timeoutMs?: number };
type JiraCommentProperty = { key: string; value: unknown };
export type JiraComment = { id: string; body?: unknown; properties?: JiraCommentProperty[]; created?: string };
export type JiraAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content?: string;
  self?: string;
  author?: { displayName?: string };
};

export class JiraClient {
  constructor(
    private readonly profile: JiraProfile,
    private readonly token: string,
    private readonly attachmentMaxBytes = 10_485_760,
  ) {}

  async myself() {
    return this.request<Record<string, unknown>>("/rest/api/3/myself");
  }

  async listProjects() {
    const data = await this.request<{ values?: Array<{ id: string; key: string; name: string }> }>("/rest/api/3/project/search?maxResults=100");
    return data.values ?? [];
  }

  async project(projectKey: string) {
    return this.request<Record<string, unknown>>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  }

  async metadata(projectKey: string) {
    const [fields, issueTypes] = await Promise.all([
      this.request<Array<{ id: string; name: string; custom: boolean; schema?: { type?: string } }>>("/rest/api/3/field"),
      this.request<Array<{ id: string; name: string; subtask: boolean }>>(`/rest/api/3/issuetype/project?projectId=${encodeURIComponent(await this.projectId(projectKey))}`),
    ]);
    return { fields, issueTypes };
  }

  async getIssue(issueKey: string) {
    return this.request<Record<string, any>>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=*all`);
  }

  async createIssue(input: {
    projectKey: string;
    issueType: string;
    summary: string;
    description?: string;
    acceptanceCriteria?: string;
    parentIssueKey?: string;
    fields?: Record<string, unknown>;
  }) {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      ...mapCustomFields(this.profile, input.fields),
    };
    if (input.description !== undefined) fields.description = toAdf(input.description);
    if (input.parentIssueKey) fields.parent = { key: input.parentIssueKey };
    const acceptanceField = this.profile.customFieldMap.acceptanceCriteria;
    if (input.acceptanceCriteria !== undefined && acceptanceField) fields[acceptanceField] = toAdf(input.acceptanceCriteria);
    return this.request<{ id: string; key: string; self: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
  }

  async editIssue(issueKey: string, input: { summary?: string; description?: string; acceptanceCriteria?: string; fields?: Record<string, unknown> }) {
    const fields: Record<string, unknown> = mapCustomFields(this.profile, input.fields);
    if (input.summary !== undefined) fields.summary = input.summary;
    if (input.description !== undefined) fields.description = toAdf(input.description);
    const acceptanceField = this.profile.customFieldMap.acceptanceCriteria;
    if (input.acceptanceCriteria !== undefined) {
      if (!acceptanceField) throw new AppError("FIELD_VALIDATION_FAILED", "Acceptance criteria field is not configured", 400);
      fields[acceptanceField] = toAdf(input.acceptanceCriteria);
    }
    await this.request<void>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
    return this.getIssue(issueKey);
  }

  async linkIssues(inwardIssueKey: string, outwardIssueKey: string, linkType = "Relates") {
    const response = await this.rawRequest("/rest/api/3/issueLink", {
      method: "POST",
      body: JSON.stringify({ type: { name: linkType }, inwardIssue: { key: inwardIssueKey }, outwardIssue: { key: outwardIssueKey } }),
    });
    if (!response.ok) throw await jiraError(response);
    return { inwardIssue: inwardIssueKey, outwardIssue: outwardIssueKey, type: linkType };
  }

  async transitions(issueKey: string) {
    const data = await this.request<{ transitions: Array<{ id: string; name: string; to: { id: string; name: string } }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return data.transitions;
  }

  async transition(issueKey: string, target: string) {
    return (await this.ensureTransition(issueKey, target)).issue;
  }

  async ensureTransition(issueKey: string, target: string) {
    const desired = this.profile.statusAliases[target] ?? target;
    const issueBefore = await this.getIssue(issueKey);
    const currentStatus = String(issueBefore.fields?.status?.name ?? "");
    if (normalizeText(currentStatus) === normalizeText(desired)) {
      return { issue: issueBefore, requested: target, targetStatus: desired, applied: false, noOp: true };
    }
    const transitions = await this.transitions(issueKey);
    const normalized = normalizeText(desired);
    const matches = transitions.filter((item) => normalizeText(item.name) === normalized || normalizeText(item.to.name) === normalized || item.id === target);
    if (matches.length !== 1) {
      throw new AppError("TRANSITION_NOT_AVAILABLE", matches.length ? "Transition is ambiguous" : "Transition is not available", 409, {
        available: transitions.map((item) => ({ id: item.id, name: item.name, to: item.to.name })),
      });
    }
    await this.request<void>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: matches[0].id } }),
    });
    return { issue: await this.getIssue(issueKey), requested: target, targetStatus: desired, applied: true, noOp: false };
  }

  async addComment(issueKey: string, body: string | Record<string, unknown>, properties: JiraCommentProperty[] = []) {
    return this.request<JiraComment>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: typeof body === "string" ? toAdf(body) : body, ...(properties.length ? { properties } : {}) }),
    });
  }

  async findCommentByProperty(issueKey: string, propertyKey: string, expectedValue: string) {
    let startAt = 0;
    while (true) {
      const data = await this.request<{ comments?: JiraComment[]; startAt?: number; maxResults?: number; total?: number }>(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100&expand=properties`,
      );
      const comments = data.comments ?? [];
      const found = comments.find((comment) => comment.properties?.some((property) =>
        property.key === propertyKey && typeof property.value === "object" && property.value !== null &&
        String((property.value as Record<string, unknown>).eventKey ?? "") === expectedValue));
      if (found) return found;
      const consumed = startAt + comments.length;
      if (!comments.length || consumed >= (data.total ?? consumed)) return undefined;
      startAt = consumed;
    }
  }

  async listAttachments(issueKey: string) {
    const issue = await this.getIssue(issueKey);
    return (issue.fields?.attachment ?? []) as JiraAttachment[];
  }

  async uploadAttachment(issueKey: string, filename: string, content: Buffer, mimeType = "application/octet-stream") {
    if (content.byteLength > this.attachmentMaxBytes) {
      throw new AppError("ATTACHMENT_TOO_LARGE", `Attachment exceeds ${this.attachmentMaxBytes} bytes`, 413);
    }
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(content)], { type: mimeType }), filename);
    return this.request<JiraAttachment[]>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
      timeoutMs: 60_000,
    });
  }

  attachmentContentUrl(attachment: Pick<JiraAttachment, "id" | "content">) {
    return attachment.content ?? `${this.profile.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachment.id)}`;
  }

  async readAttachment(issueKey: string, attachmentId: string, maxBytes = this.attachmentMaxBytes) {
    const attachments = await this.listAttachments(issueKey);
    const attachment = attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new AppError("ISSUE_NOT_FOUND", "Attachment does not belong to the issue", 404);
    const limit = Math.min(maxBytes, this.attachmentMaxBytes);
    if (attachment.size > limit) throw new AppError("ATTACHMENT_TOO_LARGE", `Attachment exceeds ${limit} bytes`, 413);

    const first = await this.rawRequest(`/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}?redirect=false`, { redirect: "manual" });
    let response = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      if (!location) throw new AppError("ISSUE_NOT_FOUND", "Attachment redirect is missing", 502);
      try {
        response = await fetch(location, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new AppError("JIRA_UNAVAILABLE", "Jira attachment download is temporarily unavailable", 503, { transient: true });
      }
    }
    if (!response.ok) throw await jiraError(response);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new AppError("ATTACHMENT_TOO_LARGE", `Attachment exceeds ${limit} bytes`, 413);
    const mimeType = attachment.mimeType || response.headers.get("content-type") || "application/octet-stream";
    const textual = /^(text\/|application\/(json|xml|csv))/.test(mimeType);
    return {
      id: attachment.id,
      filename: attachment.filename,
      mimeType,
      size: buffer.byteLength,
      text: textual ? buffer.toString("utf8") : undefined,
      base64: textual ? undefined : buffer.toString("base64"),
    };
  }

  private async projectId(projectKey: string) {
    const project = await this.project(projectKey);
    return String(project.id);
  }

  private async request<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.rawRequest(path, options);
    if (!response.ok) throw await jiraError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async rawRequest(path: string, options: FetchOptions = {}) {
    const { timeoutMs = 30_000, headers, ...rest } = options;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Accept", requestHeaders.get("Accept") ?? "application/json");
    requestHeaders.set("Authorization", `Basic ${Buffer.from(`${this.profile.email}:${this.token}`).toString("base64")}`);
    if (!(rest.body instanceof FormData) && !requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
    try {
      return await fetch(`${this.profile.baseUrl}${path}`, {
        ...rest,
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
        headers: requestHeaders,
      });
    } catch {
      throw new AppError("JIRA_UNAVAILABLE", "Jira is temporarily unavailable", 503, { transient: true });
    }
  }
}

export function toAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      content: paragraph ? [{ type: "text", text: paragraph }] : [],
    })),
  };
}

export function toAdfWithLinks(text: string, links: Array<{ label: string; href: string }>) {
  const content: Array<Record<string, unknown>> = toAdf(text).content;
  if (links.length) {
    content.push({
      type: "bulletList",
      content: links.map((link) => ({
        type: "listItem",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: link.label,
            marks: [{ type: "link", attrs: { href: link.href } }],
          }],
        }],
      })),
    });
  }
  return { type: "doc", version: 1, content };
}

export function mapCustomFields(profile: Pick<JiraProfile, "customFieldMap">, fields: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([name, value]) => [profile.customFieldMap[name] ?? name, value]),
  );
}

async function jiraError(response: Response) {
  let details: unknown;
  try { details = await response.json(); } catch { details = await response.text(); }
  const transient = response.status === 429 || response.status >= 500;
  const code = response.status === 401 ? "JIRA_AUTH_FAILED" : response.status === 404 ? "ISSUE_NOT_FOUND" : response.status === 429 ? "JIRA_RATE_LIMITED" : response.status >= 500 ? "JIRA_UNAVAILABLE" : "JIRA_REQUEST_FAILED";
  return new AppError(code, `Jira returned HTTP ${response.status}`, response.status, { response: details, transient, retryAfter: response.headers.get("retry-after") ?? undefined });
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
}
