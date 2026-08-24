import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { AppError } from "./domain.js";

const catalogSchema = z.object({
  version: z.string(),
  templates: z.array(z.object({
    id: z.string(), version: z.string(), file: z.string(), target: z.string(),
  })),
  commands: z.array(z.object({
    id: z.string(), version: z.string(), file: z.string(), target: z.string(),
  })).default([]),
  agents: z.array(z.object({
    id: z.string(), version: z.string(), file: z.string(), target: z.string(),
  })).default([]),
  artifacts: z.array(z.object({
    id: z.string(), version: z.string(), file: z.string(), target: z.string(),
  })).default([]),
  obsoleteCommands: z.array(z.object({ target: z.string(), managedSectionId: z.string() })).default([]),
  partials: z.array(z.object({ id: z.string(), file: z.string() })).default([]),
});

export type TemplatePart = { key: string; kind: "text" | "section"; sectionId?: string; content: string };
export type CatalogTemplate = { id: string; version: string; target: string; content: string; parts: TemplatePart[] };
export type SddCatalog = {
  version: string;
  templates: Map<string, CatalogTemplate>;
  commands: Map<string, CatalogTemplate>;
  agents: Map<string, CatalogTemplate>;
  artifacts: Map<string, CatalogTemplate>;
  obsoleteCommands: Array<{ target: string; managedSectionId: string }>;
};
export type Detection = { templateIds: string[]; evidence: Record<string, string[]>; validationCommands: string[] };

const ignoredDirectories = new Set([".git", ".svn", ".hg", "node_modules", "dist", "build", ".next", ".expo", ".dart_tool", "coverage", "vendor", "Pods", ".gradle"]);
const backendDependencies = new Set(["express", "fastify", "@nestjs/core", "koa", "hapi", "@hapi/hapi", "restify", "apollo-server", "@apollo/server"]);
const datadogDependencies = new Set(["dd-trace", "dd-trace-api"]);
const openApiDependencies = new Set(["swagger-autogen", "swagger-jsdoc", "swagger-ui-express", "@nestjs/swagger", "openapi3-ts", "yamljs"]);

export function loadSddCatalog(root: string): SddCatalog {
  const parsed = catalogSchema.parse(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")));
  const partials = new Map<string, string>();
  for (const entry of parsed.partials) {
    const content = readFileSync(join(root, "partials", entry.file), "utf8");
    if (content.includes("<!-- sdd:partial")) throw new AppError("SDD_CATALOG_INVALID", `Partial ${entry.id} must not reference other partials`, 500);
    partials.set(entry.id, content.trim());
  }
  const templates = new Map<string, CatalogTemplate>();
  for (const entry of parsed.templates) {
    const content = expandPartials(readFileSync(join(root, "templates", entry.file), "utf8"), partials, `Template ${entry.id}`);
    const parts = parseTemplateParts(content);
    if (!parts.some((part) => part.kind === "section")) throw new AppError("SDD_CATALOG_INVALID", `Template ${entry.id} has no managed sections`, 500);
    templates.set(entry.id, { id: entry.id, version: entry.version, target: entry.target, content, parts });
  }
  const commands = loadManagedEntries(root, "commands", "Command", ".claude/commands/", parsed.commands, partials);
  const agents = loadManagedEntries(root, "agents", "Agent", ".claude/agents/", parsed.agents, partials);
  const artifacts = loadManagedEntries(root, "artifacts", "Artifact", "docs/sdd/specs/", parsed.artifacts, partials);
  return { version: parsed.version, templates, commands, agents, artifacts, obsoleteCommands: parsed.obsoleteCommands };
}

export function expandPartials(content: string, partials: Map<string, string>, owner: string) {
  const expanded = content.replace(/^[ \t]*<!-- sdd:partial ([a-z0-9._-]+) -->[ \t]*$/gm, (_match, id: string) => {
    const partial = partials.get(id);
    if (partial === undefined) throw new AppError("SDD_CATALOG_INVALID", `${owner} references unknown partial ${id}`, 500);
    return partial;
  });
  if (expanded.includes("<!-- sdd:partial")) throw new AppError("SDD_CATALOG_INVALID", `${owner} has a malformed partial marker`, 500);
  return expanded;
}

function loadManagedEntries(root: string, directory: string, kind: string, targetPrefix: string, entries: Array<{ id: string; version: string; file: string; target: string }>, partials: Map<string, string>) {
  const result = new Map<string, CatalogTemplate>();
  for (const entry of entries) {
    if (!entry.target.startsWith(targetPrefix) || entry.target.split("/").includes("..")) throw new AppError("SDD_CATALOG_INVALID", `${kind} ${entry.id} has an unsafe target`, 500);
    const content = expandPartials(readFileSync(join(root, directory, entry.file), "utf8"), partials, `${kind} ${entry.id}`);
    const parts = parseTemplateParts(content);
    if (!parts.some((part) => part.kind === "section")) throw new AppError("SDD_CATALOG_INVALID", `${kind} ${entry.id} has no managed sections`, 500);
    result.set(entry.id, { id: entry.id, version: entry.version, target: entry.target, content, parts });
  }
  return result;
}

export function detectProject(workspace: string): Detection {
  const packageFiles: string[] = [];
  const pubspecFiles: string[] = [];
  walk(workspace, workspace, 0, packageFiles, pubspecFiles);
  const selected = new Set<string>();
  const evidence: Record<string, string[]> = {};
  const validation = new Set<string>();

  for (const pubspec of pubspecFiles) {
    const content = safeRead(pubspec);
    if (/sdk\s*:\s*flutter|\bflutter\s*:/m.test(content)) {
      addDetection(selected, evidence, "flutter", relative(workspace, pubspec));
      validation.add("dart format ."); validation.add("flutter analyze"); validation.add("flutter test");
    }
  }

  for (const packageFile of packageFiles) {
    const packageJson = safeJson(packageFile);
    if (!packageJson) continue;
    const dependencies = allDependencies(packageJson);
    const file = relative(workspace, packageFile);
    const hasReactNative = dependencies.has("react-native") || dependencies.has("expo");
    const hasReact = dependencies.has("react") && dependencies.has("react-dom");
    const hasAngular = dependencies.has("@angular/core");
    const hasTypeScript = dependencies.has("typescript") || existsNear(packageFile, "tsconfig.json");
    const hasBackend = intersects(dependencies, backendDependencies) || backendScript(packageJson.scripts);

    if (hasReactNative) {
      addDetection(selected, evidence, "react", `${file}: react-native inherits React`);
      addDetection(selected, evidence, "react-native", file);
    } else if (hasReact) {
      addDetection(selected, evidence, "react", file);
    }
    if (hasAngular) addDetection(selected, evidence, "angular", file);
    if (hasTypeScript && hasBackend) addDetection(selected, evidence, "node-typescript", file);
    if (hasTypeScript && hasBackend && intersects(dependencies, datadogDependencies)) addDetection(selected, evidence, "node-datadog", `${file}: dd-trace`);
    if (hasTypeScript && hasBackend && intersects(dependencies, openApiDependencies)) addDetection(selected, evidence, "node-openapi", `${file}: OpenAPI/Swagger`);

    const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts as Record<string, unknown> : {};
    for (const name of ["lint", "typecheck", "test", "build"]) if (typeof scripts[name] === "string") validation.add(`npm run ${name}`);
  }

  return { templateIds: [...selected], evidence, validationCommands: [...validation] };
}

export function parseTemplateParts(content: string): TemplatePart[] {
  const pattern = /<!-- sdd:section ([a-z0-9._-]+):start -->([\s\S]*?)<!-- sdd:section \1:end -->/gi;
  const matches = [...content.matchAll(pattern)];
  const parts: TemplatePart[] = [];
  let offset = 0;
  let previous = "start";
  for (const match of matches) {
    const index = match.index ?? 0;
    const text = content.slice(offset, index);
    if (text) parts.push({ key: `text:${previous}:${match[1]}`, kind: "text", content: text });
    parts.push({ key: `section:${match[1]}`, kind: "section", sectionId: match[1], content: match[0] });
    previous = match[1]; offset = index + match[0].length;
  }
  const tail = content.slice(offset);
  if (tail) parts.push({ key: `text:${previous}:end`, kind: "text", content: tail });
  return parts;
}

export function partHashes(parts: TemplatePart[]) {
  return Object.fromEntries(parts.map((part) => [part.key, sha256(part.content)]));
}

export function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

function walk(root: string, directory: string, depth: number, packages: string[], pubspecs: string[]) {
  if (depth > 5 || packages.length + pubspecs.length > 200) return;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".env") || ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(root, path, depth + 1, packages, pubspecs);
    else if (entry.isFile() && entry.name === "package.json") packages.push(path);
    else if (entry.isFile() && entry.name === "pubspec.yaml") pubspecs.push(path);
  }
}

function safeRead(path: string) { try { if (statSync(path).size > 1_000_000) return ""; return readFileSync(path, "utf8"); } catch { return ""; } }
function safeJson(path: string): Record<string, unknown> | undefined { try { return JSON.parse(safeRead(path)); } catch { return undefined; } }
function allDependencies(pkg: Record<string, unknown>) {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const group = pkg[key]; if (group && typeof group === "object") for (const name of Object.keys(group)) names.add(name);
  }
  return names;
}
function intersects(values: Set<string>, expected: Set<string>) { return [...expected].some((value) => values.has(value)); }
function existsNear(packageFile: string, name: string) { try { return statSync(join(dirname(packageFile), name)).isFile(); } catch { return false; } }
function backendScript(value: unknown) { if (!value || typeof value !== "object") return false; return Object.values(value).some((script) => typeof script === "string" && /(?:^|\s)(?:node|tsx|ts-node|nest)\b/.test(script)); }
function addDetection(selected: Set<string>, evidence: Record<string, string[]>, id: string, item: string) { selected.add(id); (evidence[id] ??= []).push(item); }
