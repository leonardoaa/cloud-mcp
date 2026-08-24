import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Express, NextFunction, Request, Response } from "express";
import { Router } from "express";
import { resolve } from "node:path";
import { ZodError, z } from "zod";
import type { CallLogRepository } from "./repositories.js";
import type { IssueService, JiraProfileService, WorkspaceService } from "./services.js";
import { AppError } from "./domain.js";
import type { SddKanbanService } from "./sdd-kanban.js";

type AdminServices = { profiles: JiraProfileService; workspaces: WorkspaceService; issues: IssueService; callLogs: CallLogRepository; sddKanban: SddKanbanService };
type Session = { csrf: string; expiresAt: number };

const cardColumnSchema = z.enum(["sdd-task", "planning", "sdd-build", "blocked", "done"]);
const runnerProfileSchema = z.enum(["claude-default", "claude-admin", "claude-ollama-kimi"]);
const commandKindSchema = z.enum(["sdd-task", "sdd-plan", "sdd-build"]);

export function registerAdminApi(app: Express, services: AdminServices, adminPassword: string) {
  const router = Router();
  const sessions = new Map<string, Session>();

  router.post("/session", asyncHandler(async (req, res) => {
    const password = z.object({ password: z.string() }).parse(req.body).password;
    if (!safeEqual(password, adminPassword)) throw new AppError("UNAUTHORIZED", "Invalid credentials", 401);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    sessions.set(token, { csrf, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    res.cookie("mcp_admin_session", token, { httpOnly: true, secure: req.secure, sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/" });
    res.json({ csrf });
  }));

  router.get("/session", requireSession(sessions), asyncHandler(async (req, res) => {
    const session = resLocals(req).adminSession as Session;
    res.json({ csrf: session.csrf, expiresAt: session.expiresAt });
  }));

  router.delete("/session", requireSession(sessions), requireCsrf, asyncHandler(async (req, res) => {
    sessions.delete(req.cookies.mcp_admin_session);
    res.clearCookie("mcp_admin_session", { path: "/" });
    res.status(204).end();
  }));

  router.use(requireSession(sessions));
  router.use((req, res, next) => req.method === "GET" ? next() : requireCsrf(req, res, next));

  router.get("/jira-profiles", asyncHandler(async (_req, res) => res.json(services.profiles.list())));
  router.post("/jira-profiles", asyncHandler(async (req, res) => res.status(201).json(await services.profiles.create(req.body))));
  router.get("/jira-profiles/:id", asyncHandler(async (req, res) => res.json(services.profiles.get(routeParam(req, "id")))));
  router.patch("/jira-profiles/:id", asyncHandler(async (req, res) => res.json(await services.profiles.update(routeParam(req, "id"), req.body))));
  router.post("/jira-profiles/:id/test", asyncHandler(async (req, res) => res.json(await services.profiles.test(routeParam(req, "id")))));
  router.post("/jira-profiles/:id/rotate-credential", asyncHandler(async (req, res) => {
    const { apiToken } = z.object({ apiToken: z.string().min(8) }).parse(req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(await services.profiles.rotateCredential(routeParam(req, "id"), apiToken));
  }));
  router.post("/jira-profiles/:id/disable", asyncHandler(async (req, res) => res.json(services.profiles.disable(routeParam(req, "id")))));
  router.get("/jira-profiles/:id/projects", asyncHandler(async (req, res) => res.json(await services.profiles.projects(routeParam(req, "id")))));
  router.get("/jira-profiles/:id/metadata", asyncHandler(async (req, res) => res.json(await services.profiles.metadata(routeParam(req, "id"), asString(req.query.projectKey)))));

  router.get("/workspace-bindings", asyncHandler(async (_req, res) => res.json(services.workspaces.list())));
  router.post("/workspace-bindings", asyncHandler(async (req, res) => {
    const input = z.object({ workspacePath: z.string(), jiraProfileId: z.string(), jiraProjectKey: z.string() }).parse(req.body);
    res.status(201).json(await services.workspaces.bind(input.workspacePath, input.jiraProfileId, input.jiraProjectKey));
  }));
  router.delete("/workspace-bindings/:id", asyncHandler(async (req, res) => res.json(services.workspaces.remove(routeParam(req, "id")))));

  router.get("/sdd/runner-profiles", asyncHandler(async (_req, res) => res.json(services.sddKanban.profiles())));
  router.get("/sdd/cards", asyncHandler(async (req, res) => res.json(services.sddKanban.listCards(requiredQuery(req, "workspaceId")))));
  router.post("/sdd/cards", asyncHandler(async (req, res) => {
    const input = z.object({
      workspaceId: z.string().min(1),
      title: z.string().min(1),
      requestText: z.string().default(""),
      runnerProfileId: runnerProfileSchema.optional(),
      jiraIssueKey: z.string().optional(),
    }).parse(req.body);
    res.status(201).json(services.sddKanban.createCard(input));
  }));
  router.patch("/sdd/cards/:id", asyncHandler(async (req, res) => {
    const patch = z.object({
      title: z.string().min(1).optional(),
      requestText: z.string().optional(),
      jiraIssueKey: z.string().optional(),
      runnerProfileId: runnerProfileSchema.optional(),
    }).parse(req.body);
    res.json(services.sddKanban.updateCard(routeParam(req, "id"), patch));
  }));
  router.post("/sdd/cards/:id/move", asyncHandler(async (req, res) => {
    const { column } = z.object({ column: cardColumnSchema }).parse(req.body);
    res.json(services.sddKanban.moveCard(routeParam(req, "id"), column));
  }));
  router.post("/sdd/cards/:id/sessions", asyncHandler(async (req, res) => {
    const input = z.object({
      commandKind: commandKindSchema.optional(),
      confirmedDanger: z.boolean().optional(),
      cols: z.number().int().min(40).max(240).optional(),
      rows: z.number().int().min(10).max(80).optional(),
    }).parse(req.body);
    res.status(201).json(await services.sddKanban.startSession(routeParam(req, "id"), input));
  }));
  router.get("/sdd/sessions/:id", asyncHandler(async (req, res) => res.json(services.sddKanban.getSession(routeParam(req, "id")))));
  router.post("/sdd/sessions/:id/input", asyncHandler(async (req, res) => {
    const { data } = z.object({ data: z.string().max(20_000) }).parse(req.body);
    res.json(services.sddKanban.sendInput(routeParam(req, "id"), data));
  }));
  router.post("/sdd/sessions/:id/initial-command", asyncHandler(async (req, res) => res.json(services.sddKanban.sendInitialCommand(routeParam(req, "id")))));
  router.post("/sdd/sessions/:id/stop", asyncHandler(async (req, res) => res.json(services.sddKanban.stopSession(routeParam(req, "id")))));
  router.get("/sdd/sessions/:id/stream", asyncHandler(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const unsubscribe = services.sddKanban.subscribe(routeParam(req, "id"), (chunk) => res.write(`event: terminal\ndata: ${JSON.stringify({ chunk })}\n\n`));
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  }));

  router.get("/issues/:issueKey", asyncHandler(async (req, res) => res.json(await services.issues.get(requiredQuery(req, "workspacePath"), routeParam(req, "issueKey")))));
  router.post("/issues/tasks", asyncHandler(async (req, res) => {
    const { workspacePath, ...input } = req.body;
    res.status(201).json(await services.issues.createTask(workspacePath, input));
  }));
  router.post("/issues/subtasks", asyncHandler(async (req, res) => {
    const { workspacePath, ...input } = req.body;
    res.status(201).json(await services.issues.createSubtask(workspacePath, input));
  }));
  router.patch("/issues/:issueKey", asyncHandler(async (req, res) => {
    const { workspacePath, ...input } = req.body;
    res.json(await services.issues.edit(workspacePath, routeParam(req, "issueKey"), input));
  }));
  router.get("/issues/:issueKey/transitions", asyncHandler(async (req, res) => res.json(await services.issues.transitions(requiredQuery(req, "workspacePath"), routeParam(req, "issueKey")))));
  router.post("/issues/:issueKey/transitions", asyncHandler(async (req, res) => res.json(await services.issues.transition(req.body.workspacePath, routeParam(req, "issueKey"), req.body.targetStatus))));
  router.get("/issues/:issueKey/attachments", asyncHandler(async (req, res) => res.json(await services.issues.attachments(requiredQuery(req, "workspacePath"), routeParam(req, "issueKey")))));
  router.post("/issues/:issueKey/attachments", asyncHandler(async (req, res) => {
    const input = z.object({ workspacePath: z.string(), fileName: z.string().min(1), mimeType: z.string().min(1), dataBase64: z.string().min(1) }).parse(req.body);
    res.status(201).json(await services.issues.addAttachment(input.workspacePath, routeParam(req, "issueKey"), input.fileName, input.mimeType, input.dataBase64));
  }));
  router.get("/issues/:issueKey/attachments/:attachmentId", asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await services.issues.readAttachment(requiredQuery(req, "workspacePath"), routeParam(req, "issueKey"), routeParam(req, "attachmentId")));
  }));

  router.get("/mcp-call-logs", asyncHandler(async (req, res) => res.json(services.callLogs.list({ targetName: asString(req.query.targetName), outcome: asString(req.query.outcome), before: asString(req.query.before), limit: req.query.limit ? Number(req.query.limit) : undefined }))));
  router.get("/mcp-call-logs/stream", asyncHandler(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const unsubscribe = services.callLogs.subscribe((log) => res.write(`event: call-log\ndata: ${JSON.stringify(log)}\n\n`));
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  }));
  router.get("/mcp-call-logs/:id", asyncHandler(async (req, res) => {
    const log = services.callLogs.get(routeParam(req, "id"));
    if (!log) throw new AppError("LOG_NOT_FOUND", "Call log not found", 404);
    res.json(log);
  }));

  router.get("/sdd-flow-print", asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'",
    );
    res.type("html").send(readFileSync(resolve("docs/sdd-fluxo-print.html"), "utf8"));
  }));

  app.use("/api/admin", router);
}

function requireSession(sessions: Map<string, Session>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.mcp_admin_session;
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt < Date.now()) return next(new AppError("UNAUTHORIZED", "Admin session required", 401));
    resLocals(req).adminSession = session;
    next();
  };
}

function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  const session = resLocals(req).adminSession as Session | undefined;
  if (!session || req.header("x-csrf-token") !== session.csrf) return next(new AppError("CSRF_FAILED", "Invalid CSRF token", 403));
  next();
}

const locals = new WeakMap<Request, Record<string, unknown>>();
function resLocals(req: Request) { const value = locals.get(req) ?? {}; locals.set(req, value); return value; }
function safeEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function asString(value: unknown) { return typeof value === "string" ? value : undefined; }
function routeParam(req: Request, name: string) { const value = req.params[name]; return Array.isArray(value) ? value[0] : value; }
function requiredQuery(req: Request, name: string) { const value = asString(req.query[name]); if (!value) throw new AppError("VALIDATION_ERROR", `${name} is required`, 400); return value; }
function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>) { return (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res, next)).catch(next); }

export function adminErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details: error.flatten() } });
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Unexpected server error", 500);
  res.status(appError.status).json({ error: { code: appError.code, message: appError.message, details: appError.status < 500 ? appError.details : undefined } });
}
