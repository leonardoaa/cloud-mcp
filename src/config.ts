import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const bootstrapProfileSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  baseUrl: z.string().url().refine((url) => url.startsWith("https://"), "baseUrl must use HTTPS"),
  email: z.string().email(),
  apiTokenEnv: z.string().min(1),
  defaultProjectKey: z.string().optional(),
  subtaskIssueType: z.string().optional(),
  statusAliases: z.record(z.string()).default({}),
  customFieldMap: z.record(z.string()).default({}),
});

function parseJson<T>(value: string | undefined, fallback: T): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("JIRA_PROFILES_JSON is not valid JSON");
  }
}

const envSchema = z.object({
  MCP_HOST: z.string().default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().positive().default(37242),
  MCP_PATH: z.string().startsWith("/").default("/mcp"),
  MCP_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:37242,http://localhost:37242"),
  MCP_SERVER_BEARER_TOKEN: z.string().min(8).default("development-only"),
  MCP_ADMIN_PASSWORD: z.string().min(8).default("development-only"),
  JIRA_CREDENTIALS_MASTER_KEY: z.string().optional(),
  JIRA_DB_PATH: z.string().default("./data/jira-mcp.sqlite"),
  JIRA_PROFILES_JSON: z.string().optional(),
  MCP_CALL_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  MCP_CALL_LOG_MAX_ROWS: z.coerce.number().int().positive().default(100_000),
  JIRA_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  MCP_WORKSPACES_HOST_ROOT: z.string().optional(),
  MCP_WORKSPACES_CONTAINER_ROOT: z.string().optional(),
  SDD_CATALOG_PATH: z.string().default("./resources/sdd"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type BootstrapProfile = z.infer<typeof bootstrapProfileSchema>;

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const bootstrapProfiles = z.array(bootstrapProfileSchema).parse(
    parseJson(parsed.JIRA_PROFILES_JSON, []),
  );

  if (parsed.NODE_ENV === "production") {
    if (parsed.MCP_SERVER_BEARER_TOKEN === "development-only") {
      throw new Error("MCP_SERVER_BEARER_TOKEN is required in production");
    }
    if (parsed.MCP_ADMIN_PASSWORD === "development-only") {
      throw new Error("MCP_ADMIN_PASSWORD is required in production");
    }
  }

  return {
    host: parsed.MCP_HOST,
    port: parsed.MCP_PORT,
    mcpPath: parsed.MCP_PATH,
    allowedOrigins: new Set(parsed.MCP_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)),
    bearerToken: parsed.MCP_SERVER_BEARER_TOKEN,
    adminPassword: parsed.MCP_ADMIN_PASSWORD,
    credentialsMasterKey: parsed.JIRA_CREDENTIALS_MASTER_KEY,
    databasePath: parsed.JIRA_DB_PATH === ":memory:" ? ":memory:" : resolve(parsed.JIRA_DB_PATH),
    bootstrapProfiles,
    callLogRetentionDays: parsed.MCP_CALL_LOG_RETENTION_DAYS,
    callLogMaxRows: parsed.MCP_CALL_LOG_MAX_ROWS,
    attachmentMaxBytes: parsed.JIRA_ATTACHMENT_MAX_BYTES,
    workspacesHostRoot: resolve(parsed.MCP_WORKSPACES_HOST_ROOT ?? ".."),
    workspacesServerRoot: resolve(parsed.MCP_WORKSPACES_CONTAINER_ROOT ?? parsed.MCP_WORKSPACES_HOST_ROOT ?? ".."),
    sddCatalogPath: resolve(parsed.SDD_CATALOG_PATH),
    nodeEnv: parsed.NODE_ENV,
  };
}
