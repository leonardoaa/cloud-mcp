import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError } from "./domain.js";
import { sddEventTypes, type ConfluenceService, type IssueService, type JiraProfileService, type WorkspaceService } from "./services.js";
import type { SddInstrumentationService } from "./sdd-service.js";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

type Services = {
  profiles: JiraProfileService;
  workspaces: WorkspaceService;
  issues: IssueService;
  confluence: ConfluenceService;
  sdd: SddInstrumentationService;
  adminBaseUrl: string;
};

type ToolDefinition = {
  name: string;
  purpose: string;
  requiredArguments: string[];
  optionalArguments: string[];
  mutatesState: boolean;
  requiresWorkspaceBinding: boolean;
  category: string;
};

const toolDefinitions: ToolDefinition[] = [
  def("jira_help", "List capabilities and common workflows", [], ["topic", "workspacePath"], false, false, "overview"),
  def("jira_list_profiles", "List configured Jira profiles", [], [], false, false, "profiles"),
  def("jira_create_profile", "Start secure Jira profile creation in the admin UI", [], [], true, false, "profiles"),
  def("jira_test_connection", "Test a Jira profile connection", ["jiraProfileId"], [], false, false, "profiles"),
  def("jira_list_projects", "List projects accessible through a Jira profile", ["jiraProfileId"], [], false, false, "profiles"),
  def("jira_bind_workspace", "Associate a workspace with a Jira profile and project", ["workspacePath", "jiraProfileId", "jiraProjectKey"], [], true, false, "workspaces"),
  def("jira_get_workspace_binding", "Get the Jira binding for a workspace", ["workspacePath"], [], false, false, "workspaces"),
  def("jira_unbind_workspace", "Remove a workspace binding", ["workspaceId"], [], true, false, "workspaces"),
  def("jira_get_issue", "Read a Jira issue and attachment metadata", ["workspacePath", "issueKey"], [], false, true, "issues"),
  def("jira_create_task", "Create a task in the bound Jira project", ["workspacePath", "summary"], ["description", "acceptanceCriteria", "issueType", "fields"], true, true, "issues"),
  def("jira_edit_task", "Edit fields on an existing issue", ["workspacePath", "issueKey"], ["summary", "description", "acceptanceCriteria", "fields"], true, true, "issues"),
  def("jira_create_subtask", "Create a subtask under an existing issue", ["workspacePath", "parentIssueKey", "summary"], ["description", "acceptanceCriteria", "fields"], true, true, "issues"),
  def("jira_link_issues", "Link the bound issue to another issue, across projects", ["workspacePath", "issueKey", "targetIssueKey"], ["linkType"], true, true, "issues"),
  def("jira_list_transitions", "List currently available issue transitions", ["workspacePath", "issueKey"], [], false, true, "transitions"),
  def("jira_transition_issue", "Move an issue or subtask through its workflow", ["workspacePath", "issueKey", "targetStatus"], [], true, true, "transitions"),
  def("jira_add_comment", "Add a comment to an issue in the bound Jira project", ["workspacePath", "issueKey", "body"], [], true, true, "comments"),
  def("jira_record_sdd_event", "Record an idempotent SDD progress event and optional status transition", ["workspacePath", "issueKey", "eventKey", "eventType", "summary"], ["targetStatus", "filesChanged", "validations", "blockers", "nextStep", "phase", "runner", "model", "modelLabel", "executionId"], true, true, "comments"),
  def("jira_list_attachments", "List attachments for an issue", ["workspacePath", "issueKey"], [], false, true, "attachments"),
  def("jira_add_attachment", "Upload an attachment to an issue", ["workspacePath", "issueKey", "fileName", "mimeType", "dataBase64"], [], true, true, "attachments"),
  def("jira_read_attachment", "Read a text or binary issue attachment", ["workspacePath", "issueKey", "attachmentId"], ["maxBytes"], false, true, "attachments"),
  def("confluence_list_spaces", "List Confluence spaces on the workspace-bound Atlassian site", ["workspacePath"], ["keys"], false, true, "confluence"),
  def("confluence_find_page", "Find a Confluence page by space and exact title (create-vs-update decision)", ["workspacePath", "spaceKey", "title"], [], false, true, "confluence"),
  def("confluence_get_page", "Read a Confluence page with its storage body and version", ["workspacePath", "pageId"], [], false, true, "confluence"),
  def("confluence_create_page", "Create a Confluence page in a space, optionally under a parent", ["workspacePath", "spaceKey", "title", "body"], ["parentId", "representation"], true, true, "confluence"),
  def("confluence_update_page", "Update a Confluence page, auto-incrementing its version", ["workspacePath", "pageId", "title", "body"], ["representation"], true, true, "confluence"),
  def("sdd_init", "Detect project stacks and install versioned development standards", [], ["workspacePath", "action", "previewId"], true, false, "sdd"),
];

export function createMcpServer(services: Services) {
  const server = new McpServer({ name: "cloud-jira-mcp", version: "0.1.0" });

  server.registerTool("jira_help", {
    description: "List Jira MCP capabilities, arguments, workflows, and the recommended next action.",
    inputSchema: {
      topic: z.enum(["overview", "profiles", "workspaces", "issues", "transitions", "comments", "attachments", "sdd", "troubleshooting"]).optional(),
      workspacePath: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ topic = "overview", workspacePath }) => result(async () => {
    let context: Record<string, unknown> | undefined;
    if (workspacePath) {
      try {
        const binding = services.workspaces.resolve(workspacePath);
        context = { workspaceResolved: true, workspaceBound: true, jiraProfileId: binding.jiraProfileId, jiraProjectKey: binding.jiraProjectKey, recommendedNextTool: "jira_get_issue" };
      } catch {
        context = { workspaceResolved: true, workspaceBound: false, recommendedNextTool: "jira_bind_workspace" };
      }
    }
    return {
      server: { name: "cloud-jira-mcp", version: "0.1.0" },
      topic,
      tools: topic === "overview" ? toolDefinitions : toolDefinitions.filter((tool) => tool.category === topic || tool.name === "jira_help"),
      commonWorkflows: [
        { goal: "Use Jira from a new workspace", steps: ["jira_list_profiles", "jira_bind_workspace", "jira_create_task"] },
        { goal: "Add a Jira profile", steps: ["jira_create_profile", "Complete the secure admin form", "jira_test_connection"] },
        { goal: "Move an issue", steps: ["jira_list_transitions", "jira_transition_issue"] },
        { goal: "Record SDD progress", steps: ["jira_record_sdd_event(eventType=TASK_STARTED)", "Perform and validate the work", "jira_record_sdd_event(eventType=TASK_COMPLETED)"] },
        { goal: "Refine and create a Jira task with /sdd-task", steps: ["jira_get_workspace_binding", "Review missing information and confirm the final draft", "jira_create_task"] },
        { goal: "Document a project on Confluence with /sdd-doc", steps: ["jira_get_workspace_binding", "confluence_list_spaces", "confluence_find_page", "confluence_create_page or confluence_update_page"] },
        { goal: "Instrument a project with SDD", steps: ["sdd_init(action=preview)", "Review changes and warnings", "sdd_init(action=apply, previewId=...)"] },
        { goal: "Plan and build an existing Jira issue", steps: ["Run /sdd-plan <ISSUE-KEY>", "Resolve any product blockers", "Run /sdd-build <ISSUE-KEY>"] },
      ],
      currentContext: context,
    };
  }));

  server.registerTool("jira_list_profiles", {
    description: "List configured Jira profiles without credentials.", inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => result(async () => ({ profiles: services.profiles.list(), addNew: { tool: "jira_create_profile" } })));

  server.registerTool("jira_create_profile", {
    description: "Return the secure admin page used to create a Jira profile. Secrets must never be sent as tool arguments.", inputSchema: {},
  }, async () => result(async () => ({ actionRequired: true, url: `${services.adminBaseUrl}/admin/jiras`, message: "Open the authenticated admin page and choose Add Jira." })));

  server.registerTool("jira_test_connection", {
    description: "Test authentication and project visibility for a Jira profile.", inputSchema: { jiraProfileId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ jiraProfileId }) => result(() => services.profiles.test(jiraProfileId)));

  server.registerTool("jira_list_projects", {
    description: "List projects accessible through a Jira profile.", inputSchema: { jiraProfileId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ jiraProfileId }) => result(() => services.profiles.projects(jiraProfileId)));

  server.registerTool("jira_bind_workspace", {
    description: "Associate a workspace path with a Jira profile and project.", inputSchema: { workspacePath: z.string(), jiraProfileId: z.string(), jiraProjectKey: z.string() },
  }, async ({ workspacePath, jiraProfileId, jiraProjectKey }) => result(() => services.workspaces.bind(workspacePath, jiraProfileId, jiraProjectKey)));

  server.registerTool("jira_get_workspace_binding", {
    description: "Read the Jira binding for a workspace.", inputSchema: { workspacePath: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath }) => result(async () => {
    const binding = services.workspaces.resolve(workspacePath);
    return { ...binding, jiraProfile: services.profiles.get(binding.jiraProfileId) };
  }));

  server.registerTool("jira_unbind_workspace", {
    description: "Remove a workspace Jira binding.", inputSchema: { workspaceId: z.string() }, annotations: { destructiveHint: true },
  }, async ({ workspaceId }) => result(async () => services.workspaces.remove(workspaceId)));

  server.registerTool("jira_get_issue", {
    description: "Read an issue, subtasks, status, and attachment metadata.", inputSchema: { workspacePath: z.string(), issueKey: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, issueKey }) => result(() => services.issues.get(workspacePath, issueKey)));

  server.registerTool("jira_create_task", {
    description: "Create a task in the project bound to the workspace.", inputSchema: issueCreateShape(false),
  }, async (input: { workspacePath: string; summary: string; description?: string; acceptanceCriteria?: string; issueType?: string; fields?: Record<string, unknown> }) => result(() => services.issues.createTask(input.workspacePath, input)));

  server.registerTool("jira_create_subtask", {
    description: "Create a subtask under a Jira issue.", inputSchema: issueCreateShape(true),
  }, async (input: { workspacePath: string; parentIssueKey: string; summary: string; description?: string; acceptanceCriteria?: string; fields?: Record<string, unknown> }) => result(() => services.issues.createSubtask(input.workspacePath, input)));

  server.registerTool("jira_link_issues", {
    description: "Create an issue link (default Relates) from the bound issue to another issue, including across projects.",
    inputSchema: { workspacePath: z.string(), issueKey: z.string(), targetIssueKey: z.string(), linkType: z.string().optional() },
  }, async ({ workspacePath, issueKey, targetIssueKey, linkType }) => result(() => services.issues.linkIssues(workspacePath, issueKey, targetIssueKey, linkType)));

  server.registerTool("jira_edit_task", {
    description: "Edit fields on a task or subtask; use jira_transition_issue for status.",
    inputSchema: { workspacePath: z.string(), issueKey: z.string(), summary: z.string().optional(), description: z.string().optional(), acceptanceCriteria: z.string().optional(), fields: z.record(z.unknown()).optional() },
  }, async ({ workspacePath, issueKey, ...input }) => result(() => services.issues.edit(workspacePath, issueKey, input)));

  server.registerTool("jira_list_transitions", {
    description: "List transitions currently available for an issue.", inputSchema: { workspacePath: z.string(), issueKey: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, issueKey }) => result(() => services.issues.transitions(workspacePath, issueKey)));

  server.registerTool("jira_transition_issue", {
    description: "Transition a task or subtask to a target status or alias.", inputSchema: { workspacePath: z.string(), issueKey: z.string(), targetStatus: z.string() },
  }, async ({ workspacePath, issueKey, targetStatus }) => result(() => services.issues.transition(workspacePath, issueKey, targetStatus)));

  server.registerTool("jira_add_comment", {
    description: "Add a plain-text comment to a task or subtask in the workspace-bound Jira project.",
    inputSchema: { workspacePath: z.string(), issueKey: z.string(), body: z.string().min(1).max(10_000) },
  }, async ({ workspacePath, issueKey, body }) => result(() => services.issues.addComment(workspacePath, issueKey, body)));

  server.registerTool("jira_record_sdd_event", {
    description: "Idempotently record a structured SDD lifecycle comment, optionally transitioning the issue first. Reuse eventKey on retry.",
    inputSchema: {
      workspacePath: z.string(), issueKey: z.string(),
      eventKey: z.string().min(1).max(255).regex(/^[A-Za-z0-9._:/-]+$/),
      eventType: z.enum(sddEventTypes), summary: z.string().min(1).max(500),
      targetStatus: z.string().min(1).max(100).optional(),
      filesChanged: z.array(z.string().min(1).max(500)).max(50).optional(),
      validations: z.array(z.object({ command: z.string().min(1).max(500), status: z.enum(["PASS", "FAIL", "SKIPPED"]), summary: z.string().max(500).optional() })).max(50).optional(),
      blockers: z.array(z.string().min(1).max(500)).max(50).optional(),
      nextStep: z.string().max(500).optional(),
      phase: z.enum(["task", "plan", "build"]).optional(),
      runner: z.enum(["claude", "ollama"]).optional(),
      model: z.string().min(1).max(200).optional(),
      modelLabel: z.string().min(1).max(200).optional(),
      executionId: z.string().min(1).max(100).optional(),
    },
  }, async ({ workspacePath, issueKey, ...input }) => result(() => services.issues.recordSddEvent(workspacePath, issueKey, input)));

  server.registerTool("jira_list_attachments", {
    description: "List issue attachments and their metadata.", inputSchema: { workspacePath: z.string(), issueKey: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, issueKey }) => result(() => services.issues.attachments(workspacePath, issueKey)));

  server.registerTool("jira_add_attachment", {
    description: "Upload a base64-encoded attachment to an issue with the configured server size limit.",
    inputSchema: {
      workspacePath: z.string(), issueKey: z.string(), fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(255), dataBase64: z.string().min(1),
    },
  }, async ({ workspacePath, issueKey, fileName, mimeType, dataBase64 }) => result(() =>
    services.issues.addAttachment(workspacePath, issueKey, fileName, mimeType, dataBase64)));

  server.registerTool("jira_read_attachment", {
    description: "Read an attachment with a server-enforced size limit.", inputSchema: { workspacePath: z.string(), issueKey: z.string(), attachmentId: z.string(), maxBytes: z.number().int().positive().optional() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, issueKey, attachmentId, maxBytes }) => result(() => services.issues.readAttachment(workspacePath, issueKey, attachmentId, maxBytes)));

  server.registerTool("confluence_list_spaces", {
    description: "List Confluence spaces on the Atlassian site bound to the workspace. Filter by space keys when provided.",
    inputSchema: { workspacePath: z.string(), keys: z.array(z.string()).optional() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, keys }) => result(() => services.confluence.listSpaces(workspacePath, keys)));

  server.registerTool("confluence_find_page", {
    description: "Find a Confluence page by space key and exact title. Use before create/update to avoid duplicates.",
    inputSchema: { workspacePath: z.string(), spaceKey: z.string(), title: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, spaceKey, title }) => result(() => services.confluence.findPage(workspacePath, spaceKey, title)));

  server.registerTool("confluence_get_page", {
    description: "Read a Confluence page with its storage-format body and current version.",
    inputSchema: { workspacePath: z.string(), pageId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ workspacePath, pageId }) => result(() => services.confluence.getPage(workspacePath, pageId)));

  server.registerTool("confluence_create_page", {
    description: "Create a Confluence page in a space, optionally under a parent page. Body defaults to storage-format XHTML.",
    inputSchema: {
      workspacePath: z.string(), spaceKey: z.string(), title: z.string().min(1), body: z.string(),
      parentId: z.string().optional(), representation: z.enum(["storage", "atlas_doc_format", "wiki"]).optional(),
    },
  }, async ({ workspacePath, ...input }) => result(() => services.confluence.createPage(workspacePath, input)));

  server.registerTool("confluence_update_page", {
    description: "Update a Confluence page by id, auto-incrementing its version. Body defaults to storage-format XHTML.",
    inputSchema: {
      workspacePath: z.string(), pageId: z.string(), title: z.string().min(1), body: z.string(),
      representation: z.enum(["storage", "atlas_doc_format", "wiki"]).optional(),
    },
  }, async ({ workspacePath, ...input }) => result(() => services.confluence.updatePage(workspacePath, input)));

  server.registerTool("sdd_init", {
    description: "Detect the caller project stack and preview or apply SDD standards under docs/sdd/templates. Preview is required before apply.",
    inputSchema: {
      workspacePath: z.string().optional(),
      action: z.enum(["preview", "apply"]).default("preview"),
      previewId: z.string().optional(),
    },
    annotations: { idempotentHint: true, openWorldHint: false },
  }, async ({ workspacePath, action, previewId }, extra) => result(async () => {
    if (action === "apply") {
      if (!previewId) throw new AppError("SDD_PREVIEW_REQUIRED", "previewId is required for apply", 400);
      return services.sdd.apply(previewId);
    }
    const resolvedWorkspace = workspacePath ?? await workspaceFromRoots(extra);
    return services.sdd.preview(resolvedWorkspace);
  }));

  return server;
}

function def(name: string, purpose: string, requiredArguments: string[], optionalArguments: string[], mutatesState: boolean, requiresWorkspaceBinding: boolean, category: string): ToolDefinition {
  return { name, purpose, requiredArguments, optionalArguments, mutatesState, requiresWorkspaceBinding, category };
}

function issueCreateShape(subtask: boolean) {
  return {
    workspacePath: z.string(),
    ...(subtask ? { parentIssueKey: z.string() } : { issueType: z.string().optional() }),
    summary: z.string().min(1),
    description: z.string().optional(),
    acceptanceCriteria: z.string().optional(),
    fields: z.record(z.unknown()).optional(),
  };
}

async function result(action: () => unknown | Promise<unknown>) {
  try {
    const data = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: { data } };
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error", 500);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: { code: appError.code, message: appError.message, details: appError.details } }, null, 2) }],
      structuredContent: { error: { code: appError.code, message: appError.message, details: appError.details } },
    };
  }
}

async function workspaceFromRoots(extra: { sendRequest: Function }) {
  try {
    const response = await extra.sendRequest({ method: "roots/list" }, ListRootsResultSchema) as { roots: Array<{ uri: string }> };
    const fileRoots = response.roots.filter((root) => root.uri.startsWith("file://"));
    if (fileRoots.length !== 1) throw new AppError("WORKSPACE_REQUIRED", "Exactly one filesystem root is required, or pass workspacePath", 400);
    return fileURLToPath(fileRoots[0].uri);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("WORKSPACE_REQUIRED", "Client roots are unavailable; pass workspacePath", 400);
  }
}
