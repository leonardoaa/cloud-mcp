import type { IPty } from "node-pty";
import { createRequire } from "node:module";
import { AppError, type SddCard, type SddCardColumn, type SddCommandKind, type SddRunnerProfile, type SddTerminalSession } from "./domain.js";
import type { SddCardRepository, SddTerminalSessionRepository, WorkspaceBindingRepository } from "./repositories.js";
import type { IssueService } from "./services.js";

export const sddRunnerProfiles: SddRunnerProfile[] = [
  { id: "claude-default", label: "Claude", command: "claude", args: [], requiresStrongConfirmation: false },
  { id: "claude-admin", label: "Claude admin", command: "claude", args: ["--dangerously-skip-permissions"], requiresStrongConfirmation: true },
  {
    id: "claude-ollama-kimi",
    label: "Claude via Ollama Kimi",
    command: "ollama",
    args: ["launch", "claude", "--model", "kimi-k2.7-code:cloud", "--", "--dangerously-skip-permissions"],
    requiresStrongConfirmation: true,
  },
];
const require = createRequire(import.meta.url);

export type TerminalProcess = {
  write(data: string): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
};

export type TerminalRunner = {
  spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; profileId: SddRunnerProfile["id"] }): TerminalProcess | Promise<TerminalProcess>;
};

export class NodePtyRunner implements TerminalRunner {
  spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): TerminalProcess {
    const pty = requireNodePty().spawn(command, args, {
      name: "xterm-256color",
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
    });
    return new NodePtyProcess(pty);
  }
}

export class HostRunnerClient implements TerminalRunner {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async spawn(_command: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; profileId: SddRunnerProfile["id"] }): Promise<TerminalProcess> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ profileId: options.profileId, cwd: options.cwd, cols: options.cols, rows: options.rows }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { id: string };
    return new HostRunnerProcess(this.baseUrl, this.token, payload.id);
  }
}

export class SddKanbanService {
  private readonly processes = new Map<string, TerminalProcess>();
  private readonly listeners = new Map<string, Set<(chunk: string) => void>>();
  private readonly initialCommands = new Map<string, { commandText: string; terminal: TerminalProcess; output: string; sent: boolean; scheduled: boolean; timer?: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly cards: SddCardRepository,
    private readonly sessions: SddTerminalSessionRepository,
    private readonly bindings: WorkspaceBindingRepository,
    private readonly issues: IssueService,
    private readonly runner: TerminalRunner = new NodePtyRunner(),
    private readonly mapWorkspacePath: (clientPath: string) => string = (clientPath) => clientPath,
  ) {}

  profiles() {
    return sddRunnerProfiles;
  }

  listCards(workspaceId: string) {
    this.requireBinding(workspaceId);
    return this.cards.list(workspaceId).map((card) => ({ ...card, sessions: this.sessions.listByCard(card.id).slice(0, 5) }));
  }

  createCard(input: { workspaceId: string; title: string; requestText: string; runnerProfileId?: SddRunnerProfile["id"]; jiraIssueKey?: string }) {
    this.requireBinding(input.workspaceId);
    const profile = this.requireProfile(input.runnerProfileId ?? "claude-default");
    return this.cards.create({
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      requestText: input.requestText.trim(),
      runnerProfileId: profile.id,
      jiraIssueKey: normalizeIssueKey(input.jiraIssueKey),
    });
  }

  updateCard(id: string, patch: Partial<Pick<SddCard, "title" | "requestText" | "jiraIssueKey" | "runnerProfileId">>) {
    const card = this.requireCard(id);
    if (patch.runnerProfileId) this.requireProfile(patch.runnerProfileId);
    if (patch.jiraIssueKey !== undefined) patch.jiraIssueKey = normalizeIssueKey(patch.jiraIssueKey);
    return this.cards.update(card.id, patch);
  }

  moveCard(id: string, column: SddCardColumn) {
    const card = this.requireCard(id);
    if ((column === "planning" || column === "sdd-build") && !card.jiraIssueKey) {
      throw new AppError("SDD_ISSUE_KEY_REQUIRED", "Issue key is required before moving to this column", 409);
    }
    return this.cards.update(id, { column, status: column === "blocked" ? "blocked" : column === "done" ? "done" : "idle" });
  }

  async startSession(cardId: string, input: { commandKind?: SddCommandKind; confirmedDanger?: boolean; cols?: number; rows?: number }) {
    const card = this.requireCard(cardId);
    if (this.sessions.hasActiveForCard(card.id)) throw new AppError("SDD_SESSION_ACTIVE", "This card already has an active terminal session", 409);
    const binding = this.requireBinding(card.workspaceId);
    const profile = this.requireProfile(card.runnerProfileId);
    if (profile.requiresStrongConfirmation && !input.confirmedDanger) {
      throw new AppError("SDD_STRONG_CONFIRMATION_REQUIRED", "This runner profile requires explicit confirmation", 409, { profileId: profile.id });
    }
    const commandKind = input.commandKind ?? commandKindForColumn(card.column);
    const commandText = this.commandForCard(card, commandKind);
    if ((commandKind === "sdd-plan" || commandKind === "sdd-build") && card.jiraIssueKey) {
      await this.issues.get(binding.canonicalPath, card.jiraIssueKey);
    }
    const session = this.sessions.create({ cardId: card.id, workspaceId: card.workspaceId, commandKind, commandText, runnerProfile: profile });
    this.cards.update(card.id, { status: "running" });

    try {
      const terminalCwd = this.mapWorkspacePath(binding.canonicalPath);
      const terminal = await this.runner.spawn(profile.command, profile.args, {
        cwd: terminalCwd,
        env: { ...process.env },
        cols: input.cols ?? 100,
        rows: input.rows ?? 28,
        profileId: profile.id,
      });
      this.processes.set(session.id, terminal);
      this.registerInitialCommand(session.id, terminal, commandText);
      terminal.onData((chunk) => {
        this.observeInitialCommand(session.id, chunk);
        this.emit(session.id, chunk);
      });
      terminal.onExit(({ exitCode }) => {
        this.processes.delete(session.id);
        this.clearInitialCommand(session.id);
        const finalStatus = exitCode === 0 ? "completed" : "failed";
        this.sessions.finish(session.id, finalStatus, exitCode);
        this.cards.update(card.id, { status: finalStatus === "completed" ? "idle" : "blocked", ...(finalStatus === "failed" ? { column: "blocked" as const } : {}) });
        this.emit(session.id, `\r\n[process exited with code ${exitCode}]\r\n`);
      });
      return this.sessions.get(session.id)!;
    } catch (error) {
      this.sessions.finish(session.id, "failed", 127);
      this.cards.update(card.id, { status: "blocked", column: "blocked" });
      throw new AppError("SDD_TERMINAL_START_FAILED", error instanceof Error ? error.message : "Failed to start terminal", 500);
    }
  }

  sendInput(sessionId: string, data: string) {
    const process = this.processes.get(sessionId);
    if (!process) throw new AppError("SDD_SESSION_NOT_RUNNING", "Terminal session is not running", 409);
    const initial = this.initialCommands.get(sessionId);
    if (initial && !initial.sent && data.includes(initial.commandText)) {
      this.markInitialCommandSent(sessionId, "manual");
    }
    process.write(data);
    return { sent: true };
  }

  sendInitialCommand(sessionId: string) {
    const process = this.processes.get(sessionId);
    if (!process) throw new AppError("SDD_SESSION_NOT_RUNNING", "Terminal session is not running", 409);
    const initial = this.initialCommands.get(sessionId);
    if (!initial) return { sent: false, reason: "initial command is not available" };
    if (initial.sent) {
      this.emit(sessionId, "\r\n[sdd-kanban initial command already sent; duplicate blocked]\r\n");
      return { sent: false, reason: "initial command already sent" };
    }
    this.submitInitialCommand(sessionId, "manual");
    return { sent: true, mode: "command" };
  }

  stopSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    const process = this.processes.get(sessionId);
    if (process) {
      process.kill();
      this.processes.delete(sessionId);
      this.clearInitialCommand(sessionId);
    }
    if (session.status === "running") {
      this.sessions.finish(sessionId, "stopped");
      this.cards.update(session.cardId, { status: "blocked", column: "blocked" });
    }
    return this.sessions.get(sessionId)!;
  }

  getSession(sessionId: string) {
    return this.requireSession(sessionId);
  }

  subscribe(sessionId: string, listener: (chunk: string) => void) {
    const session = this.requireSession(sessionId);
    if (session.logTail) listener(session.logTail);
    const listeners = this.listeners.get(sessionId) ?? new Set<(chunk: string) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  private emit(sessionId: string, chunk: string) {
    this.sessions.appendLog(sessionId, chunk);
    const session = this.sessions.get(sessionId);
    if (session?.commandKind === "sdd-task") {
      const card = this.cards.get(session.cardId);
      const issueKey = card?.jiraIssueKey ? undefined : findIssueKey(`${session.logTail}${chunk}`);
      if (issueKey) this.cards.update(session.cardId, { jiraIssueKey: issueKey });
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener(chunk);
  }

  private registerInitialCommand(sessionId: string, terminal: TerminalProcess, commandText: string) {
    this.initialCommands.set(sessionId, { commandText, terminal, output: "", sent: false, scheduled: false });
    this.emit(sessionId, "\r\n[sdd-kanban waiting for Claude prompt]\r\n");
  }

  private observeInitialCommand(sessionId: string, chunk: string) {
    const initial = this.initialCommands.get(sessionId);
    if (!initial || initial.sent) return;
    initial.output = tailString(`${initial.output}${stripAnsi(chunk)}`, 12_000);
    if (!isClaudeReadyForInput(initial.output)) return;
    this.scheduleInitialCommand(sessionId);
  }

  private scheduleInitialCommand(sessionId: string) {
    const initial = this.initialCommands.get(sessionId);
    if (!initial || initial.sent || initial.scheduled) return;
    initial.scheduled = true;
    this.emit(sessionId, "\r\n[sdd-kanban Claude prompt detected; initial command scheduled]\r\n");
    initial.timer = setTimeout(() => this.submitInitialCommand(sessionId, "auto"), 900);
  }

  private submitInitialCommand(sessionId: string, source: "auto" | "manual") {
    const initial = this.initialCommands.get(sessionId);
    if (!initial || initial.sent) return;
    initial.terminal.write(initial.commandText);
    initial.terminal.write("\r");
    this.markInitialCommandSent(sessionId, source);
  }

  private markInitialCommandSent(sessionId: string, source: "auto" | "manual") {
    const initial = this.initialCommands.get(sessionId);
    if (!initial || initial.sent) return;
    if (initial.timer) clearTimeout(initial.timer);
    initial.sent = true;
    this.emit(sessionId, `\r\n[sdd-kanban initial command sent: ${source}]\r\n`);
  }

  private clearInitialCommand(sessionId: string) {
    const initial = this.initialCommands.get(sessionId);
    if (initial?.timer) clearTimeout(initial.timer);
    this.initialCommands.delete(sessionId);
  }

  private commandForCard(card: SddCard, commandKind: SddCommandKind) {
    if (commandKind === "sdd-task") {
      if (!card.requestText.trim()) throw new AppError("SDD_REQUEST_REQUIRED", "Request text is required for /sdd-task", 400);
      return `/sdd-task ${card.requestText.trim()}`;
    }
    if (!card.jiraIssueKey) throw new AppError("SDD_ISSUE_KEY_REQUIRED", "Issue key is required for this SDD command", 409);
    return commandKind === "sdd-plan" ? `/sdd-plan ${card.jiraIssueKey}` : `/sdd-build ${card.jiraIssueKey}`;
  }

  private requireCard(id: string) {
    const card = this.cards.get(id);
    if (!card) throw new AppError("SDD_CARD_NOT_FOUND", "SDD card not found", 404);
    return card;
  }

  private requireSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new AppError("SDD_SESSION_NOT_FOUND", "Terminal session not found", 404);
    return session;
  }

  private requireBinding(workspaceId: string) {
    const binding = this.bindings.get(workspaceId);
    if (!binding) throw new AppError("WORKSPACE_NOT_BOUND", "Workspace binding not found", 404);
    return binding;
  }

  private requireProfile(id: string) {
    const profile = sddRunnerProfiles.find((item) => item.id === id);
    if (!profile) throw new AppError("SDD_RUNNER_PROFILE_NOT_FOUND", "Runner profile not found", 404);
    return profile;
  }
}

function commandKindForColumn(column: SddCardColumn): SddCommandKind {
  if (column === "planning") return "sdd-plan";
  if (column === "sdd-build") return "sdd-build";
  return "sdd-task";
}

function normalizeIssueKey(value: string | undefined) {
  const trimmed = value?.trim().toUpperCase();
  return trimmed || undefined;
}

function findIssueKey(value: string) {
  return value.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
}

function isClaudeReadyForInput(output: string) {
  return [
    "Claude Code",
    "Try \"create",
    "bypass permissions on",
    "bypass permissions off",
    "shift+tab to cycle",
    "Welcome back!",
  ].some((marker) => output.includes(marker));
}

function stripAnsi(value: string) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}

function tailString(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function requireNodePty() {
  return require("node-pty") as { spawn(command: string, args: string[], options: Record<string, unknown>): IPty };
}

class NodePtyProcess implements TerminalProcess {
  constructor(private readonly pty: IPty) {}
  write(data: string) { this.pty.write(data); }
  kill() { this.pty.kill(); }
  onData(listener: (data: string) => void) { this.pty.onData(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.pty.onExit(listener); }
}

class HostRunnerProcess implements TerminalProcess {
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];
  private abort = new AbortController();

  constructor(private readonly baseUrl: string, private readonly token: string, private readonly id: string) {
    this.stream().catch((error) => {
      if (this.abort.signal.aborted) return;
      this.dataListeners.forEach((listener) => listener(`\r\n[host runner stream error: ${error instanceof Error ? error.message : "unknown"}]\r\n`));
      this.exitListeners.forEach((listener) => listener({ exitCode: 1 }));
    });
  }

  write(data: string) {
    fetch(`${this.baseUrl}/sessions/${this.id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ data }),
    }).catch(() => undefined);
  }

  kill() {
    this.abort.abort();
    fetch(`${this.baseUrl}/sessions/${this.id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    }).catch(() => undefined);
  }

  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); }

  private async stream() {
    const response = await fetch(`${this.baseUrl}/sessions/${this.id}/stream`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.handleEvent(raw);
      }
    }
  }

  private handleEvent(raw: string) {
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) return;
    const event = JSON.parse(dataLine.slice(6)) as { type: "data"; chunk: string } | { type: "exit"; exitCode: number };
    if (event.type === "data") this.dataListeners.forEach((listener) => listener(event.chunk));
    if (event.type === "exit") {
      this.abort.abort();
      this.exitListeners.forEach((listener) => listener({ exitCode: event.exitCode }));
    }
  }
}
