import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { CredentialStore } from "../src/credentials.js";
import { CallLogRepository, JiraProfileRepository, WorkspaceBindingRepository, workspaceIdentity } from "../src/repositories.js";
import { publicProfile } from "../src/domain.js";
import { JiraClient, mapCustomFields, toAdf } from "../src/jira-client.js";
import { AppError, type JiraProfile } from "../src/domain.js";
import { IssueService, renderSddProgressComment, type JiraProfileService, type WorkspaceService } from "../src/services.js";

afterEach(() => vi.restoreAllMocks());

describe("core persistence", () => {
  it("encrypts credentials and never exposes their reference publicly", () => {
    const db = openDatabase(":memory:");
    const credentials = new CredentialStore(db, Buffer.alloc(32, 7).toString("base64"));
    const reference = credentials.save("secret-token");
    expect(reference).toMatch(/^sqlite:/);
    expect(credentials.resolve(reference)).toBe("secret-token");

    const profiles = new JiraProfileRepository(db);
    const profile = profiles.create({
      id: "test", name: "Test", baseUrl: "https://test.atlassian.net/", email: "user@test.com",
      credentialRef: reference, defaultProjectKey: "TEST", subtaskIssueType: "Subtask",
      statusAliases: {}, customFieldMap: {},
    });
    expect(profile.baseUrl).toBe("https://test.atlassian.net");
    expect(publicProfile(profile)).not.toHaveProperty("credentialRef");
    db.close();
  });

  it("persists and replaces workspace bindings deterministically", () => {
    const db = openDatabase(":memory:");
    const profiles = new JiraProfileRepository(db);
    profiles.create({ id: "jira", name: "Jira", baseUrl: "https://jira.atlassian.net", email: "u@x.com", credentialRef: "env:TOKEN", statusAliases: {}, customFieldMap: {} });
    const bindings = new WorkspaceBindingRepository(db);
    const first = bindings.upsert(".", "jira", "ONE");
    const second = bindings.upsert(".", "jira", "TWO");
    expect(first.workspaceId).toBe(workspaceIdentity(".").id);
    expect(second.jiraProjectKey).toBe("TWO");
    expect(bindings.list()).toHaveLength(1);
    db.close();
  });

  it("records and completes sanitized call logs", () => {
    const db = openDatabase(":memory:");
    const logs = new CallLogRepository(db);
    const started = logs.start({ requestId: "request-1", protocolMethod: "tools/call", targetName: "jira_help", operationKind: "tool", safeSummary: {} });
    logs.finish(started.id, "success", 200);
    const saved = logs.get(started.id)!;
    expect(saved.outcome).toBe("success");
    expect(saved.httpStatus).toBe(200);
    expect(saved.durationMs).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe("Jira formatting", () => {
  it("converts paragraphs to Atlassian Document Format", () => {
    expect(toAdf("First\n\nSecond")).toEqual({
      type: "doc", version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    });
  });

  it("maps arbitrary logical field names to Jira custom field IDs", () => {
    expect(mapCustomFields(
      { customFieldMap: { acceptanceCriteria: "customfield_10000", storyPoints: "customfield_10016" } },
      { acceptanceCriteria: "Done when...", storyPoints: 5, labels: ["backend"] },
    )).toEqual({
      customfield_10000: "Done when...",
      customfield_10016: 5,
      labels: ["backend"],
    });
  });

  it("renders bounded SDD progress sections", () => {
    expect(renderSddProgressComment({
      eventKey: "SCRUM-1/run/TASK-1/started", eventType: "TASK_STARTED", summary: "Implementacao iniciada",
      filesChanged: ["src/index.ts"], validations: [{ command: "npm test", status: "PASS" }], nextStep: "Implementar contrato",
    })).toContain("SDD TASK_STARTED: Implementacao iniciada\n\nArquivos alterados:\n- src/index.ts\n\nValidacoes:\n- [PASS] npm test");
  });

  it("renders the execution model in Jira messages", () => {
    const input = { eventKey: "SCRUM-1/build/started", eventType: "PHASE_STARTED" as const, summary: "Build iniciado", phase: "build" as const, runner: "claude" as const, model: "menu:2:Opus", modelLabel: "Opus 4.8", executionId: "execution-1" };
    expect(renderSddProgressComment(input)).toContain("Execucao: Claude · Opus 4.8 · Execucao");
  });

  it("posts Jira comments with ADF and an idempotency property", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "comment-1", created: "2026-06-21T00:00:00.000Z" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JiraClient(profile(), "token");
    await client.addComment("SCRUM-1", "Started", [{ key: "cloud.sdd.event", value: { eventKey: "event-1" } }]);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.body.type).toBe("doc");
    expect(request.properties[0]).toEqual({ key: "cloud.sdd.event", value: { eventKey: "event-1" } });
  });

  it("links two issues across projects with a Relates link by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new JiraClient(profile(), "token").linkIssues("BACK-12", "FRONT-8");
    expect(fetchMock.mock.calls[0][0]).toBe("https://jira.example.com/rest/api/3/issueLink");
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).toEqual({ type: { name: "Relates" }, inwardIssue: { key: "BACK-12" }, outwardIssue: { key: "FRONT-8" } });
    expect(result).toEqual({ inwardIssue: "BACK-12", outwardIssue: "FRONT-8", type: "Relates" });
  });

  it("uploads attachments as multipart without forcing a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "10", filename: "report.png", mimeType: "image/png", size: 3 }], 200));
    vi.stubGlobal("fetch", fetchMock);
    await new JiraClient(profile(), "token").uploadAttachment("SCRUM-1", "report.png", Buffer.from("png"), "image/png");
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(options.headers);
    expect(headers.get("X-Atlassian-Token")).toBe("no-check");
    expect(headers.has("Content-Type")).toBe(false);
    expect(options.body).toBeInstanceOf(FormData);
  });

  it("finds an existing SDD event comment without creating a duplicate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      startAt: 0, maxResults: 100, total: 1,
      comments: [{ id: "comment-1", properties: [{ key: "cloud.sdd.event", value: { eventKey: "event-1" } }] }],
    })));
    const found = await new JiraClient(profile(), "token").findCommentByProperty("SCRUM-1", "cloud.sdd.event", "event-1");
    expect(found?.id).toBe("comment-1");
  });

  it("treats an already reached Jira status as a transition no-op", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ fields: { status: { name: "Em andamento" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new JiraClient(profile(), "token").ensureTransition("SCRUM-1", "inProgress");
    expect(result.noOp).toBe(true);
    expect(result.applied).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes network failures as transient Jira unavailability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket closed")));
    await expect(new JiraClient(profile(), "token").getIssue("SCRUM-1")).rejects.toMatchObject({ code: "JIRA_UNAVAILABLE", status: 503, details: { transient: true } } satisfies Partial<AppError>);
  });

  it.each([[429, "JIRA_RATE_LIMITED"], [503, "JIRA_UNAVAILABLE"]] as const)("marks Jira HTTP %s as transient", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "temporary" }, status)));
    await expect(new JiraClient(profile(), "token").getIssue("SCRUM-1")).rejects.toMatchObject({ code, details: { transient: true } });
  });

  it("rejects comments for issues outside the workspace-bound project", async () => {
    const addComment = vi.fn();
    const client = { getIssue: vi.fn().mockResolvedValue({ fields: { project: { key: "OTHER" } } }), addComment };
    const issues = new IssueService(
      { client: () => client } as unknown as JiraProfileService,
      { resolve: () => ({ workspaceId: "w", jiraProfileId: "jira", jiraProjectKey: "SCRUM" }) } as unknown as WorkspaceService,
    );
    await expect(issues.addComment("/workspace", "OTHER-1", "Nope")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_BOUND_PROJECT" });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("deduplicates a previously recorded SDD event", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({ fields: { project: { key: "SCRUM" }, status: { name: "Em andamento" } } }),
      findCommentByProperty: vi.fn().mockResolvedValue({ id: "comment-1", created: "2026-06-21T00:00:00.000Z" }),
      ensureTransition: vi.fn(), addComment: vi.fn(),
    };
    const issues = new IssueService(
      { client: () => client } as unknown as JiraProfileService,
      { resolve: () => ({ workspaceId: "w", jiraProfileId: "jira", jiraProjectKey: "SCRUM" }) } as unknown as WorkspaceService,
    );
    const result = await issues.recordSddEvent("/workspace", "SCRUM-1", { eventKey: "event-1", eventType: "TASK_STARTED", summary: "Started", targetStatus: "inProgress" });
    expect(result.deduplicated).toBe(true);
    expect(client.ensureTransition).not.toHaveBeenCalled();
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it("transitions before posting a new SDD event comment", async () => {
    const calls: string[] = [];
    const client = {
      getIssue: vi.fn().mockResolvedValue({ fields: { project: { key: "SCRUM" }, status: { name: "Aberto" } } }),
      findCommentByProperty: vi.fn().mockResolvedValue(undefined),
      ensureTransition: vi.fn().mockImplementation(async () => { calls.push("transition"); return { requested: "inProgress", targetStatus: "Em andamento", applied: true, noOp: false }; }),
      addComment: vi.fn().mockImplementation(async () => { calls.push("comment"); return { id: "comment-1" }; }),
    };
    const issues = new IssueService(
      { client: () => client } as unknown as JiraProfileService,
      { resolve: () => ({ workspaceId: "w", jiraProfileId: "jira", jiraProjectKey: "SCRUM" }) } as unknown as WorkspaceService,
    );
    const result = await issues.recordSddEvent("/workspace", "SCRUM-1", { eventKey: "event-2", eventType: "TASK_STARTED", summary: "Started", targetStatus: "inProgress" });
    expect(calls).toEqual(["transition", "comment"]);
    expect(result.transition).toMatchObject({ applied: true, noOp: false });
  });

});

function profile(): JiraProfile {
  return {
    id: "jira", name: "Jira", baseUrl: "https://jira.example.com", email: "user@example.com", credentialRef: "test",
    statusAliases: { inProgress: "Em andamento", done: "Concluido" }, customFieldMap: {}, enabled: true, source: "runtime", createdAt: "", updatedAt: "",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
