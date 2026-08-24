import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { JiraProfileRepository, SddCardRepository, SddTerminalSessionRepository, WorkspaceBindingRepository } from "../src/repositories.js";
import { SddKanbanService, sddRunnerProfiles, type TerminalProcess, type TerminalRunner } from "../src/sdd-kanban.js";
import type { IssueService } from "../src/services.js";

describe("SDD Kanban", () => {
  it("defines the exact Claude runner presets", () => {
    expect(sddRunnerProfiles).toEqual([
      { id: "claude-default", label: "Claude", command: "claude", args: [], requiresStrongConfirmation: false },
      { id: "claude-admin", label: "Claude admin", command: "claude", args: ["--dangerously-skip-permissions"], requiresStrongConfirmation: true },
      {
        id: "claude-ollama-kimi",
        label: "Claude via Ollama Kimi",
        command: "ollama",
        args: ["launch", "claude", "--model", "kimi-k2.7-code:cloud", "--", "--dangerously-skip-permissions"],
        requiresStrongConfirmation: true,
      },
    ]);
  });

  it("creates and moves local cards while blocking plan without an issue key", () => {
    const { service, db, binding } = fixture();
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Nova tarefa", requestText: "Criar tela" });
    expect(card.column).toBe("sdd-task");
    expect(service.listCards(binding.workspaceId)).toHaveLength(1);
    expect(() => service.moveCard(card.id, "planning")).toThrow(/Issue key/);
    const linked = service.updateCard(card.id, { jiraIssueKey: "scrum-123" });
    expect(linked.jiraIssueKey).toBe("SCRUM-123");
    expect(service.moveCard(card.id, "planning").column).toBe("planning");
    db.close();
  });

  it("requires strong confirmation for dangerous profiles", async () => {
    const { service, db, binding } = fixture();
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Build", requestText: "Fazer", runnerProfileId: "claude-admin" });
    await expect(service.startSession(card.id, { commandKind: "sdd-task" })).rejects.toMatchObject({ code: "SDD_STRONG_CONFIRMATION_REQUIRED" });
    db.close();
  });

  it("starts a fake terminal, streams output, accepts input and stops", async () => {
    const runner = new FakeRunner();
    const { service, db, binding } = fixture(runner, () => "/workspaces/project");
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Task", requestText: "Criar API", runnerProfileId: "claude-ollama-kimi" });
    const session = await service.startSession(card.id, { commandKind: "sdd-task", confirmedDanger: true });
    expect(runner.calls[0]).toMatchObject({
      command: "ollama",
      args: ["launch", "claude", "--model", "kimi-k2.7-code:cloud", "--", "--dangerously-skip-permissions"],
      cwd: "/workspaces/project",
    });
    const chunks: string[] = [];
    const unsubscribe = service.subscribe(session.id, (chunk) => chunks.push(chunk));
    runner.process.emitData("PROJ-123 criado");
    expect(chunks.join("")).toContain("PROJ-123 criado");
    expect(service.listCards(binding.workspaceId)[0].jiraIssueKey).toBe("PROJ-123");
    service.sendInput(session.id, "sim\r");
    expect(runner.process.writes).toContain("sim\r");
    const stopped = service.stopSession(session.id);
    expect(stopped.status).toBe("stopped");
    unsubscribe();
    db.close();
  });

  it("waits for Claude readiness and a short settle delay before sending the initial command", async () => {
    const runner = new FakeRunner();
    const { service, db, binding } = fixture(runner);
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Task", requestText: "Criar API" });
    await service.startSession(card.id, { commandKind: "sdd-task" });
    expect(runner.process.writes).toEqual([]);

    runner.process.emitData("Welcome back! Try \"create a util logging.py that...\"");
    expect(runner.process.writes).toEqual([]);
    await wait(950);
    expect(runner.process.writes).toEqual(["/sdd-task Criar API", "\r"]);

    runner.process.emitData("bypass permissions on");
    expect(runner.process.writes).toEqual(["/sdd-task Criar API", "\r"]);
    db.close();
  });

  it("keeps the session running indefinitely when Claude readiness is not detected", async () => {
    const runner = new FakeRunner();
    const { service, db, binding } = fixture(runner);
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Task", requestText: "Criar API" });
    const session = await service.startSession(card.id, { commandKind: "sdd-task" });

    runner.process.emitData("booting without a prompt yet");
    expect(runner.process.writes).toEqual([]);
    expect(service.getSession(session.id).status).toBe("running");
    db.close();
  });

  it("does not duplicate the initial command when the user sends it manually", async () => {
    const runner = new FakeRunner();
    const { service, db, binding } = fixture(runner);
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Task", requestText: "Criar API" });
    const session = await service.startSession(card.id, { commandKind: "sdd-task" });

    service.sendInput(session.id, "/sdd-task Criar API\r");
    runner.process.emitData("Claude Code Welcome back! Try \"create a util logging.py that...\"");
    await wait(950);

    expect(runner.process.writes).toEqual(["/sdd-task Criar API\r"]);
    db.close();
  });

  it("can manually submit the initial command only once", async () => {
    const runner = new FakeRunner();
    const { service, db, binding } = fixture(runner);
    const card = service.createCard({ workspaceId: binding.workspaceId, title: "Task", requestText: "Criar API" });
    const session = await service.startSession(card.id, { commandKind: "sdd-task" });

    expect(service.sendInitialCommand(session.id)).toMatchObject({ sent: true, mode: "command" });
    expect(runner.process.writes).toEqual(["/sdd-task Criar API", "\r"]);

    expect(service.sendInitialCommand(session.id)).toMatchObject({ sent: false, reason: "initial command already sent" });
    expect(runner.process.writes).toEqual(["/sdd-task Criar API", "\r"]);
    db.close();
  });
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixture(runner: TerminalRunner = new FakeRunner(), mapWorkspacePath: (path: string) => string = (path) => path) {
  const db = openDatabase(":memory:");
  const profiles = new JiraProfileRepository(db);
  profiles.create({ id: "jira", name: "Jira", baseUrl: "https://jira.atlassian.net", email: "u@x.com", credentialRef: "env:TOKEN", statusAliases: {}, customFieldMap: {} });
  const bindings = new WorkspaceBindingRepository(db);
  const binding = bindings.upsert(".", "jira", "SCRUM");
  const service = new SddKanbanService(
    new SddCardRepository(db),
    new SddTerminalSessionRepository(db),
    bindings,
    { get: vi.fn().mockResolvedValue({ key: "SCRUM-1" }) } as unknown as IssueService,
    runner,
    mapWorkspacePath,
  );
  return { db, binding, service };
}

class FakeRunner implements TerminalRunner {
  readonly process = new FakeProcess();
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  spawn(command: string, args: string[], options: { cwd: string }): TerminalProcess {
    this.calls.push({ command, args, cwd: options.cwd });
    return this.process;
  }
}

class FakeProcess implements TerminalProcess {
  readonly writes: string[] = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];
  write(data: string) { this.writes.push(data); }
  kill() { this.emitExit(143); }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  emitData(data: string) { this.dataListeners.forEach((listener) => listener(data)); }
  emitExit(exitCode: number) { this.exitListeners.forEach((listener) => listener({ exitCode })); }
}
