import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { sddRunnerProfiles } from "./sdd-kanban.js";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

const port = Number(process.env.HOST_RUNNER_PORT ?? 37243);
const host = process.env.HOST_RUNNER_HOST ?? "127.0.0.1";
const token = process.env.HOST_RUNNER_TOKEN ?? process.env.MCP_SERVER_BEARER_TOKEN ?? "";
const workspaceRoot = process.env.HOST_RUNNER_WORKSPACES_ROOT ?? process.env.MCP_WORKSPACES_HOST_ROOT ?? "";

if (token.length < 8) {
  throw new Error("HOST_RUNNER_TOKEN or MCP_SERVER_BEARER_TOKEN must be configured with at least 8 characters");
}
if (!workspaceRoot) {
  throw new Error("HOST_RUNNER_WORKSPACES_ROOT or MCP_WORKSPACES_HOST_ROOT must be configured");
}

const resolvedWorkspaceRoot = path.resolve(workspaceRoot);

type Session = {
  id: string;
  pty: HostPty;
  status: "running" | "exited";
  exitCode?: number;
  tail: string;
  listeners: Set<(event: RunnerEvent) => void>;
};
type RunnerEvent = { type: "data"; chunk: string } | { type: "exit"; exitCode: number };
type HostPty = {
  write(data: string): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
};

const sessions = new Map<string, Session>();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));
app.use((req, res, next) => {
  if (req.path === "/health/live") return next();
  const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(provided, token)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health/live", (_req, res) => res.json({ status: "ok" }));

app.post("/sessions", (req, res, next) => {
  try {
    const input = z.object({
      profileId: z.string().min(1),
      cwd: z.string().min(1),
      cols: z.number().int().min(40).max(240).default(100),
      rows: z.number().int().min(10).max(80).default(28),
    }).parse(req.body);
    const profile = sddRunnerProfiles.find((item) => item.id === input.profileId);
    if (!profile) return res.status(400).json({ error: "Unknown runner profile" });
    const cwd = requireWorkspacePath(input.cwd);
    const commandLine = [
      "cd",
      shellQuote(cwd),
      "&&",
      "exec",
      shellQuote(profile.command),
      ...profile.args.map(shellQuote),
    ].join(" ");
    const child = spawnHostPty(commandLine, input.cols, input.rows);
    const session: Session = { id: randomUUID(), pty: child, status: "running", tail: "", listeners: new Set() };
    sessions.set(session.id, session);
    child.onData((chunk) => {
      session.tail = tail(session.tail + chunk, 30_000);
      emit(session, { type: "data", chunk });
    });
    child.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      emit(session, { type: "exit", exitCode });
    });
    res.status(201).json({ id: session.id, status: session.status });
  } catch (error) {
    next(error);
  }
});

app.get("/sessions/:id/stream", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  res.write(": connected\n\n");
  if (session.tail) writeEvent(res, { type: "data", chunk: session.tail });
  if (session.status === "exited") writeEvent(res, { type: "exit", exitCode: session.exitCode ?? 1 });
  const listener = (event: RunnerEvent) => writeEvent(res, event);
  session.listeners.add(listener);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => { clearInterval(heartbeat); session.listeners.delete(listener); });
});

app.post("/sessions/:id/input", (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    if (session.status !== "running") return res.status(409).json({ error: "Session is not running" });
    const { data } = z.object({ data: z.string().max(20_000) }).parse(req.body);
    session.pty.write(data);
    res.json({ sent: true });
  } catch (error) {
    next(error);
  }
});

app.post("/sessions/:id/stop", (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  if (session.status === "running") session.pty.kill();
  res.json({ stopped: true });
});

app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected host runner error";
  res.status(400).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Cloud host runner listening on http://${host}:${port}`);
});

function emit(session: Session, event: RunnerEvent) {
  for (const listener of session.listeners) listener(event);
}

function writeEvent(res: Response, event: RunnerEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function requireSession(req: Request, res: Response) {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const session = sessions.get(id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return undefined;
  }
  return session;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function tail(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function requireWorkspacePath(value: string) {
  const resolved = path.resolve(value);
  const relative = path.relative(resolvedWorkspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace path is outside HOST_RUNNER_WORKSPACES_ROOT");
  }
  return resolved;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function spawnHostPty(commandLine: string, cols: number, rows: number): HostPty {
  try {
    const child = pty.spawn("zsh", ["-lc", commandLine], {
      name: "xterm-256color",
      cwd: "/tmp",
      env: { ...process.env },
      cols,
      rows,
    });
    return {
      write: (data) => child.write(data),
      kill: () => child.kill(),
      onData: (listener) => child.onData(listener),
      onExit: (listener) => child.onExit(listener),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("posix_spawnp")) throw error;
    return new ExpectPty(commandLine, cols, rows);
  }
}

class ExpectPty implements HostPty {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(commandLine: string, cols: number, rows: number) {
    const expectScript = [
      "log_user 1",
      "set timeout -1",
      "spawn -noecho /bin/zsh -lc $env(SDD_HOST_RUNNER_COMMAND)",
      "interact",
      "set status [wait]",
      "exit [lindex $status 3]",
    ].join("\n");
    this.child = spawn("/usr/bin/expect", ["-c", expectScript], {
      cwd: "/tmp",
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows), SDD_HOST_RUNNER_COMMAND: commandLine },
    });
  }

  write(data: string) {
    this.child.stdin.write(data);
  }

  kill() {
    this.child.kill();
  }

  onData(listener: (chunk: string) => void) {
    this.child.stdout.on("data", (chunk) => listener(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => listener(chunk.toString("utf8")));
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.child.on("exit", (code) => listener({ exitCode: code ?? 1 }));
  }
}
