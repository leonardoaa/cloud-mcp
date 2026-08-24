import { loadConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { openDatabase } from "./database.js";
import { createHttpServer } from "./http-server.js";
import { CallLogRepository, JiraProfileRepository, WorkspaceBindingRepository } from "./repositories.js";
import { ConfluenceService, IssueService, JiraProfileService, WorkspaceService } from "./services.js";
import { SddInstrumentationService, SddPreviewRepository, WorkspacePathMapper } from "./sdd-service.js";

export function createApplication(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const db = openDatabase(config.databasePath);
  const profileRepository = new JiraProfileRepository(db);
  profileRepository.importBootstrap(config.bootstrapProfiles);
  const bindingRepository = new WorkspaceBindingRepository(db);
  const callLogs = new CallLogRepository(db);
  const credentials = new CredentialStore(db, config.credentialsMasterKey);
  const profiles = new JiraProfileService(profileRepository, credentials, config);
  const workspaces = new WorkspaceService(bindingRepository, profiles);
  const issues = new IssueService(profiles, workspaces);
  const confluence = new ConfluenceService(profiles, workspaces);
  const workspaceMapper = new WorkspacePathMapper(config.workspacesHostRoot, config.workspacesServerRoot);
  const sdd = new SddInstrumentationService(
    config.sddCatalogPath,
    workspaceMapper,
    new SddPreviewRepository(db),
    (workspacePath) => workspaces.findOptional(workspacePath),
  );
  const server = createHttpServer(config, { profiles, workspaces, issues, confluence, callLogs, sdd });
  const retention = setInterval(() => callLogs.retain(config.callLogRetentionDays, config.callLogMaxRows), 24 * 60 * 60 * 1000);
  retention.unref();
  callLogs.retain(config.callLogRetentionDays, config.callLogMaxRows);
  return {
    config, db, profiles, workspaces, issues, confluence, sdd, callLogs, server,
    close: async () => { clearInterval(retention); await server.close(); db.close(); },
  };
}

if (process.env.NODE_ENV !== "test") {
  const application = createApplication();
  await application.server.listen();
  const shutdown = async () => { await application.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
