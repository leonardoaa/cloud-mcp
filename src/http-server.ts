import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import pino from "pino";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { registerAdminApi, adminErrorHandler } from "./admin.js";
import { createMcpServer } from "./mcp.js";
import type { CallLogRepository } from "./repositories.js";
import type { ConfluenceService, IssueService, JiraProfileService, WorkspaceService } from "./services.js";
import type { SddInstrumentationService } from "./sdd-service.js";
import type { SddKanbanService } from "./sdd-kanban.js";

type RuntimeServices = { profiles: JiraProfileService; workspaces: WorkspaceService; issues: IssueService; confluence: ConfluenceService; sdd: SddInstrumentationService; sddKanban: SddKanbanService; callLogs: CallLogRepository };

export function createHttpServer(config: AppConfig, services: RuntimeServices) {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "apiToken", "token"] });
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    const requestId = randomUUID();
    (req as Request & { id: string }).id = requestId;
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();
    res.on("finish", () => logger.info({ requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }, "HTTP request"));
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src data: blob:; object-src 'none'");
    next();
  });

  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => res.json({ status: "ready" }));

  registerAdminApi(app, services, config.adminPassword);

  const authMcp = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && !config.allowedOrigins.has(origin)) return res.status(403).json({ error: "Origin is not allowed" });
    const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!safeEqual(provided, config.bearerToken)) return res.status(401).json({ error: "Unauthorized" });
    next();
  };

  const auditMcp = (req: Request, res: Response, next: NextFunction) => {
    const requestId = String((req as Request & { id?: string }).id ?? randomUUID());
    const body = req.body as { method?: string; params?: { name?: string; uri?: string; arguments?: Record<string, unknown> } };
    const targetName = body.params?.name ?? body.params?.uri;
    const log = services.callLogs.start({
      requestId,
      protocolMethod: body.method ?? "invalid",
      targetName,
      operationKind: body.method === "tools/call" ? "tool" : "protocol",
      safeSummary: sanitizeSummary(targetName, body.params?.arguments),
    });
    res.on("finish", () => services.callLogs.finish(log.id, res.statusCode < 400 ? "success" : "error", res.statusCode));
    next();
  };

  app.post(config.mcpPath, auditMcp, authMcp, (req, res, next) => {
    handleMcpPost(req, res, transports, services, config).catch(next);
  });

  app.get(config.mcpPath, authMcp, (req, res, next) => handleExistingTransport(req, res, transports).catch(next));
  app.delete(config.mcpPath, authMcp, (req, res, next) => handleExistingTransport(req, res, transports).catch(next));

  const webRoot = resolve("dist-web");
  if (existsSync(webRoot)) {
    app.use("/admin", express.static(webRoot, { index: "index.html" }));
    app.get(/^\/admin(?:\/.*)?$/, (_req, res) => res.sendFile(resolve(webRoot, "index.html")));
  } else {
    app.get("/admin", (_req, res) => res.status(503).send("Admin UI has not been built. Run npm run build:web."));
  }

  app.use(adminErrorHandler);

  let httpServer: Server | undefined;
  return {
    app,
    listen: () => new Promise<Server>((resolveListen, reject) => {
      httpServer = app.listen(config.port, config.host, () => {
        logger.info({ host: config.host, port: config.port, mcpPath: config.mcpPath }, "MCP server listening");
        resolveListen(httpServer!);
      });
      httpServer.on("error", reject);
    }),
    close: async () => {
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
      await new Promise<void>((done) => httpServer ? httpServer.close(() => done()) : done());
    },
  };
}

async function handleMcpPost(req: Request, res: Response, transports: Map<string, StreamableHTTPServerTransport>, services: RuntimeServices, config: AppConfig) {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport && !sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport!); },
    });
    transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); };
    const server = createMcpServer({ ...services, adminBaseUrl: publicBaseUrl(req, config) });
    await server.connect(transport);
  }
  if (!transport) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
}

async function handleExistingTransport(req: Request, res: Response, transports: Map<string, StreamableHTTPServerTransport>) {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) { res.status(400).send("Invalid or missing MCP session"); return; }
  await transport.handleRequest(req, res);
}

function sanitizeSummary(tool: string | undefined, args: Record<string, unknown> | undefined) {
  if (!tool || !args) return {};
  const safeKeys = new Set(["jiraProfileId", "jiraProjectKey", "issueKey", "parentIssueKey", "attachmentId", "targetStatus", "eventKey", "eventType", "phase", "runner", "model", "modelLabel", "executionId"]);
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => safeKeys.has(key) && typeof value === "string"));
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function publicBaseUrl(req: Request, config: AppConfig) {
  const host = req.header("host") ?? `${config.host}:${config.port}`;
  return `${req.protocol}://${host}`;
}
