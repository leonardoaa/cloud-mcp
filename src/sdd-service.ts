import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { SqliteDatabase } from "./database.js";
import { AppError } from "./domain.js";
import type { WorkspaceBinding } from "./domain.js";
import { detectProject, loadSddCatalog, parseTemplateParts, partHashes, sha256, type CatalogTemplate, type Detection, type SddCatalog } from "./sdd-catalog.js";
import { workspaceIdentity } from "./repositories.js";

type TemplateState = { version: string; partHashes: Record<string, string> };
type InstrumentationManifest = {
  schemaVersion: 1 | 2;
  catalogVersion: string;
  detectedTemplates: string[];
  evidence: Record<string, string[]>;
  templates: Record<string, TemplateState>;
  commands?: Record<string, TemplateState>;
  agents?: Record<string, TemplateState>;
  artifacts?: Record<string, TemplateState>;
  appliedAt: string;
};
type FileChange = { path: string; operation: "create" | "update" | "delete" | "unchanged"; beforeHash: string | null; afterHash: string | null; content?: string; diff: string };
type InstrumentationPlan = {
  workspaceId: string; clientWorkspacePath: string; serverWorkspacePath: string;
  catalogVersion: string; detection: Detection; changes: FileChange[]; warnings: string[];
};

export class SddPreviewRepository {
  constructor(private readonly db: SqliteDatabase) {}
  create(plan: InstrumentationPlan) {
    const id = randomBytes(24).toString("base64url");
    const createdAt = new Date(); const expiresAt = new Date(createdAt.getTime() + 15 * 60_000);
    this.db.prepare("DELETE FROM sdd_previews WHERE expires_at < ? OR used_at IS NOT NULL").run(createdAt.toISOString());
    this.db.prepare(`INSERT INTO sdd_previews (id, workspace_id, workspace_path, plan_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, plan.workspaceId, plan.clientWorkspacePath, JSON.stringify(plan), expiresAt.toISOString(), createdAt.toISOString());
    return { id, expiresAt: expiresAt.toISOString() };
  }
  get(id: string): InstrumentationPlan {
    const row = this.db.prepare("SELECT plan_json, expires_at, used_at FROM sdd_previews WHERE id = ?").get(id) as { plan_json: string; expires_at: string; used_at: string | null } | undefined;
    if (!row) throw new AppError("SDD_PREVIEW_NOT_FOUND", "Preview not found", 404);
    if (row.used_at) throw new AppError("SDD_PREVIEW_USED", "Preview was already applied", 409);
    if (Date.parse(row.expires_at) <= Date.now()) throw new AppError("SDD_PREVIEW_EXPIRED", "Preview expired; generate a new preview", 409);
    return JSON.parse(row.plan_json) as InstrumentationPlan;
  }
  markUsed(id: string) { this.db.prepare("UPDATE sdd_previews SET used_at = ? WHERE id = ?").run(new Date().toISOString(), id); }
}

export class WorkspacePathMapper {
  private readonly hostRoot: string;
  private readonly serverRoot: string;
  constructor(hostRoot: string, serverRoot: string) {
    this.hostRoot = resolve(hostRoot); this.serverRoot = realpathSync(resolve(serverRoot));
  }
  map(clientPath: string) {
    if (!isAbsolute(clientPath)) throw new AppError("WORKSPACE_REQUIRED", "workspacePath must be absolute", 400);
    const normalizedClient = resolve(clientPath);
    const child = relative(this.hostRoot, normalizedClient);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new AppError("WORKSPACE_OUTSIDE_ALLOWED_ROOT", "Workspace is outside the configured projects root", 403);
    const candidate = realpathSync(join(this.serverRoot, child));
    ensureInside(this.serverRoot, candidate);
    if (!statSync(candidate).isDirectory()) throw new AppError("WORKSPACE_REQUIRED", "workspacePath is not a directory", 400);
    return { clientPath: normalizedClient.replace(/\/$/, ""), serverPath: candidate.replace(/\/$/, "") };
  }
  safeTarget(workspace: string, relativePath: string) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new AppError("SDD_UNSAFE_PATH", "Unsafe target path", 403);
    const target = resolve(workspace, relativePath);
    ensureInside(workspace, target);
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    ensureInside(realpathSync(workspace), realpathSync(ancestor));
    const targetStat = tryLstat(target);
    if (targetStat) {
      if (targetStat.isSymbolicLink()) throw new AppError("SDD_UNSAFE_PATH", "Target path cannot be a symbolic link", 403);
      ensureInside(realpathSync(workspace), realpathSync(target));
    }
    return target;
  }
}

export class SddInstrumentationService {
  private readonly catalog: SddCatalog;
  constructor(
    catalogPath: string,
    private readonly mapper: WorkspacePathMapper,
    private readonly previews: SddPreviewRepository,
    private readonly findBinding: (workspacePath: string) => WorkspaceBinding | undefined,
  ) { this.catalog = loadSddCatalog(catalogPath); }

  preview(workspacePath: string) {
    const mapped = this.mapper.map(workspacePath);
    const plan = this.createPlan(mapped.clientPath, mapped.serverPath);
    const preview = this.previews.create(plan);
    return {
      action: "preview", previewId: preview.id, expiresAt: preview.expiresAt,
      workspace: mapped.clientPath, detectedTemplates: plan.detection.templateIds,
      installedCommands: [...this.catalog.commands.values()].map((item) => item.target),
      installedAgents: [...this.catalog.agents.values()].map((item) => item.target),
      evidence: plan.detection.evidence, validationCommands: plan.detection.validationCommands,
      changes: plan.changes.map(({ content: _content, ...change }) => change), warnings: plan.warnings,
    };
  }

  apply(previewId: string) {
    const plan = this.previews.get(previewId);
    const mapped = this.mapper.map(plan.clientWorkspacePath);
    if (mapped.serverPath !== plan.serverWorkspacePath) throw new AppError("SDD_PREVIEW_STALE", "Workspace mapping changed after preview", 409);
    for (const change of plan.changes) {
      const target = this.mapper.safeTarget(mapped.serverPath, change.path);
      if (fileHash(target) !== change.beforeHash) throw new AppError("SDD_PREVIEW_STALE", `${change.path} changed after preview`, 409);
    }
    const applied: Array<{ path: string; existed: boolean; content?: Buffer }> = [];
    try {
      for (const change of plan.changes.filter((item) => item.operation !== "unchanged")) {
        const target = this.mapper.safeTarget(mapped.serverPath, change.path);
        const existed = existsSync(target); const content = existed ? readFileSync(target) : undefined;
        if (change.operation === "delete") {
          rmSync(target, { force: true }); applied.push({ path: target, existed, content });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        this.mapper.safeTarget(mapped.serverPath, change.path);
        const temporary = `${target}.sdd-${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(temporary, change.content!, { encoding: "utf8", mode: 0o644 });
        renameSync(temporary, target); applied.push({ path: target, existed, content });
      }
    } catch (error) {
      for (const item of applied.reverse()) item.existed ? writeFileSync(item.path, item.content!) : rmSync(item.path, { force: true });
      throw error;
    }
    this.previews.markUsed(previewId);
    return {
      action: "apply", workspace: plan.clientWorkspacePath, templates: plan.detection.templateIds,
      commands: [...this.catalog.commands.values()].map((item) => item.target),
      agents: [...this.catalog.agents.values()].map((item) => item.target),
      changedFiles: plan.changes.filter((item) => item.operation !== "unchanged").map((item) => item.path), warnings: plan.warnings,
    };
  }

  private createPlan(clientWorkspace: string, serverWorkspace: string): InstrumentationPlan {
    const detection = detectProject(serverWorkspace);
    if (!detection.templateIds.length) throw new AppError("SDD_STACK_NOT_DETECTED", "No supported stack was detected", 422);
    const manifestPath = this.mapper.safeTarget(serverWorkspace, "docs/sdd/.instrumentation.json");
    const manifest = readManifest(manifestPath);
    const warnings: string[] = [];
    const changes: FileChange[] = [];
    const nextTemplates: Record<string, TemplateState> = {};
    const nextCommands: Record<string, TemplateState> = {};
    const nextAgents: Record<string, TemplateState> = {};
    const nextArtifacts: Record<string, TemplateState> = {};

    for (const id of detection.templateIds) {
      const template = this.catalog.templates.get(id);
      if (!template) throw new AppError("SDD_CATALOG_INVALID", `Template ${id} is missing`, 500);
      const relativePath = `docs/sdd/templates/${template.target}`;
      const target = this.mapper.safeTarget(serverWorkspace, relativePath);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      const merged = mergeTemplate(template, existing, manifest?.templates[id], warnings);
      changes.push(changeFor(relativePath, existing, merged));
      nextTemplates[id] = { version: template.version, partHashes: partHashes(template.parts) };
    }

    for (const command of this.catalog.commands.values()) {
      const target = this.mapper.safeTarget(serverWorkspace, command.target);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      changes.push(changeFor(command.target, existing, command.content));
      nextCommands[command.id] = { version: command.version, partHashes: partHashes(command.parts) };
    }

    for (const agent of this.catalog.agents.values()) {
      const target = this.mapper.safeTarget(serverWorkspace, agent.target);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      changes.push(changeFor(agent.target, existing, agent.content));
      nextAgents[agent.id] = { version: agent.version, partHashes: partHashes(agent.parts) };
    }

    for (const artifact of this.catalog.artifacts.values()) {
      const target = this.mapper.safeTarget(serverWorkspace, artifact.target);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      const merged = mergeTemplate(artifact, existing, manifest?.artifacts?.[artifact.id], warnings);
      changes.push(changeFor(artifact.target, existing, merged));
      nextArtifacts[artifact.id] = { version: artifact.version, partHashes: partHashes(artifact.parts) };
    }

    for (const obsolete of this.catalog.obsoleteCommands) {
      const target = this.mapper.safeTarget(serverWorkspace, obsolete.target);
      if (!existsSync(target)) continue;
      const existing = readFileSync(target, "utf8");
      if (existing.includes(`<!-- sdd:section ${obsolete.managedSectionId}:start -->`)) changes.push(deleteChange(obsolete.target, existing));
      else warnings.push(`OBSOLETE_COMMAND_PRESERVED:${obsolete.target}`);
    }

    const binding = this.findBinding(clientWorkspace);
    const constitutionBody = constitutionBlock(detection, binding);
    const constitutionPath = "docs/constitution.md";
    const constitutionTarget = this.mapper.safeTarget(serverWorkspace, constitutionPath);
    const constitutionExisting = existsSync(constitutionTarget) ? readFileSync(constitutionTarget, "utf8") : undefined;
    changes.push(changeFor(constitutionPath, constitutionExisting, mergeManagedBlock(constitutionExisting, constitutionBody, "cloud-sdd")));

    const agentsPath = findAgentsPath(serverWorkspace);
    const agentsTarget = this.mapper.safeTarget(serverWorkspace, agentsPath);
    const agentsExisting = existsSync(agentsTarget) ? readFileSync(agentsTarget, "utf8") : undefined;
    changes.push(changeFor(agentsPath, agentsExisting, mergeManagedBlock(agentsExisting, agentsBlock(), "cloud-sdd")));

    const hasContentChanges = changes.some((change) => change.operation !== "unchanged");
    const nextManifest: InstrumentationManifest = { schemaVersion: 2, catalogVersion: this.catalog.version, detectedTemplates: detection.templateIds, evidence: detection.evidence, templates: nextTemplates, commands: nextCommands, agents: nextAgents, artifacts: nextArtifacts, appliedAt: hasContentChanges || !manifest ? new Date().toISOString() : manifest.appliedAt };
    const manifestContent = `${JSON.stringify(nextManifest, null, 2)}\n`;
    const manifestExisting = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
    changes.push(changeFor("docs/sdd/.instrumentation.json", manifestExisting, manifestContent));

    return { workspaceId: workspaceIdentity(clientWorkspace).id, clientWorkspacePath: clientWorkspace, serverWorkspacePath: serverWorkspace, catalogVersion: this.catalog.version, detection, changes, warnings };
  }
}

function mergeTemplate(template: CatalogTemplate, existing: string | undefined, previous: TemplateState | undefined, warnings: string[]) {
  if (existing === undefined) return template.content;
  const existingParts = new Map(parseTemplateParts(existing).map((part) => [part.key, part]));
  const desiredKeys = new Set(template.parts.map((part) => part.key));
  const output = template.parts.map((desired) => {
    const local = existingParts.get(desired.key); if (!local) return desired.content;
    const baseline = previous?.partHashes[desired.key];
    const localChanged = baseline ? sha256(local.content) !== baseline : local.content !== desired.content;
    if (localChanged) {
      if (local.content !== desired.content) warnings.push(`LOCAL_SECTION_PRESERVED:${template.id}:${desired.key}`);
      return local.content;
    }
    return desired.content;
  });
  for (const local of existingParts.values()) if (!desiredKeys.has(local.key)) { output.push(local.content); warnings.push(`LOCAL_SECTION_PRESERVED:${template.id}:${local.key}`); }
  return output.join("");
}

function mergeManagedBlock(existing: string | undefined, body: string, id: string) {
  const start = `<!-- ${id}:start -->`; const end = `<!-- ${id}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  if (!existing) return `${block}\n`;
  const startAt = existing.indexOf(start); const endAt = existing.indexOf(end);
  if (startAt >= 0 && endAt >= startAt) return `${existing.slice(0, startAt)}${block}${existing.slice(endAt + end.length)}`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function constitutionBlock(detection: Detection, binding?: WorkspaceBinding) {
  const templates = detection.templateIds.map((id) => `- \`docs/sdd/templates/${id}.md\``).join("\n");
  const commands = detection.validationCommands.length ? detection.validationCommands.map((command) => `- \`${command}\``).join("\n") : "- Use os comandos de validação definidos pelo projeto.";
  const jira = binding ? `Este workspace usa o perfil Jira \`${binding.jiraProfileId}\` e o projeto \`${binding.jiraProjectKey}\`.` : "Este workspace ainda não possui vínculo Jira. A instrumentação e os padrões técnicos podem ser usados, mas `/sdd-task`, `/sdd-plan` e `/sdd-build` permanecem bloqueados até a vinculação.";
  return `## Constituição de desenvolvimento\n\nAntes de planejar ou alterar código, leia e siga todos os padrões detectados:\n\n${templates}\n\nRegras específicas do projeto escritas fora deste bloco prevalecem quando forem mais restritivas.\n\n### Validação mínima\n\n${commands}\n\n### Jira\n\n${jira}`;
}
function agentsBlock() {
  return `## Instrumentação SDD

Antes de planejar, implementar, revisar ou criar arquivos:

1. Leia \`docs/constitution.md\` e todos os templates obrigatórios referenciados por ela em \`docs/sdd/templates/\`.
2. Para features novas ou mudanças com regra de negócio, use uma spec em \`docs/sdd/specs/<ISSUE-KEY>/\`. Se ainda não existir issue refinada, comece por \`/sdd-task\` e depois execute \`/sdd-plan ISSUE-KEY\`.
3. Preserve as regras específicas do projeto escritas fora deste bloco; elas prevalecem quando forem mais restritivas.
4. Atualize \`docs/constitution.md\` quando uma decisão arquitetural aprovada mudar.
5. Use os subagentes em \`.claude/agents/\` quando estiverem disponíveis: \`sdd-orchestrator\`, \`sdd-refinement-reviewer\`, \`sdd-spec-writer\`, \`sdd-researcher\`, \`sdd-planner\`, \`sdd-jira-coordinator\`, \`sdd-implementer\` e \`sdd-qa-reviewer\`.

O fluxo operacional exige \`JIRA_GATE\`: sem workspace vinculado a um perfil e projeto Jira válidos, não execute nem produza artefatos de \`/sdd-task\`, \`/sdd-plan\` ou \`/sdd-build\`.`;
}
function findAgentsPath(workspace: string) { try { return readdirSync(workspace).find((name) => name.toLowerCase() === "agents.md") ?? "AGENTS.md"; } catch { return "AGENTS.md"; } }
function readManifest(path: string): InstrumentationManifest | undefined { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
function fileHash(path: string): string | null { try { return lstatSync(path).isFile() ? sha256(readFileSync(path)) : null; } catch { return null; } }
function tryLstat(path: string) { try { return lstatSync(path); } catch { return undefined; } }
function changeFor(path: string, existing: string | undefined, content: string): FileChange { const beforeHash = existing === undefined ? null : sha256(existing); const afterHash = sha256(content); return { path, operation: existing === undefined ? "create" : beforeHash === afterHash ? "unchanged" : "update", beforeHash, afterHash, content, diff: simpleDiff(path, existing, content) }; }
function deleteChange(path: string, existing: string): FileChange { return { path, operation: "delete", beforeHash: sha256(existing), afterHash: null, diff: simpleDiff(path, existing, undefined) }; }
function simpleDiff(path: string, before: string | undefined, after: string | undefined) {
  if (before === after) return "";
  const oldLines = before === undefined ? [] : before.split("\n");
  const newLines = after === undefined ? [] : after.split("\n");
  const header = `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n+++ ${after === undefined ? "/dev/null" : `b/${path}`}\n`;
  if (oldLines.length * newLines.length > 1_000_000) {
    return `${header}@@ summary @@\n-${oldLines.length} lines\n+${newLines.length} lines\n`;
  }
  const lengths = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      lengths[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
    }
  }
  const body: string[] = [];
  let oldIndex = 0; let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) { body.push(` ${oldLines[oldIndex]}`); oldIndex++; newIndex++; }
    else if (lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1]) body.push(`-${oldLines[oldIndex++]}`);
    else body.push(`+${newLines[newIndex++]}`);
  }
  while (oldIndex < oldLines.length) body.push(`-${oldLines[oldIndex++]}`);
  while (newIndex < newLines.length) body.push(`+${newLines[newIndex++]}`);
  return `${header}@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body.join("\n")}\n`;
}
function ensureInside(root: string, target: string) { const child = relative(root, target); if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new AppError("SDD_UNSAFE_PATH", "Path escapes the allowed workspace", 403); }
