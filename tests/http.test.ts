import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApplication } from "../src/index.js";

const applications: Array<ReturnType<typeof createApplication>> = [];

function application() {
  const app = createApplication({
    NODE_ENV: "test",
    JIRA_DB_PATH: ":memory:",
    MCP_SERVER_BEARER_TOKEN: "test-bearer-token",
    MCP_ADMIN_PASSWORD: "test-admin-password",
    JIRA_CREDENTIALS_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
    JIRA_PROFILES_JSON: "[]",
  });
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("HTTP application", () => {
  it("reports liveness and readiness", async () => {
    const { server } = application();
    await request(server.app).get("/health/live").expect(200, { status: "ok" });
    await request(server.app).get("/health/ready").expect(200, { status: "ready" });
  });

  it("authenticates the admin API and enforces CSRF", async () => {
    const { server } = application();
    const agent = request.agent(server.app);
    await request(server.app).get("/api/admin/sdd-flow-print").expect(401);
    await request(server.app).get("/api/admin/session").expect(401);
    const login = await agent.post("/api/admin/session").send({ password: "test-admin-password" }).expect(200);
    expect(login.body.csrf).toBeTypeOf("string");
    const restored = await agent.get("/api/admin/session").expect(200);
    expect(restored.body).toEqual({ csrf: login.body.csrf, expiresAt: expect.any(Number) });
    await agent.get("/api/admin/jira-profiles").expect(200, []);
    const flow = await agent.get("/api/admin/sdd-flow-print").expect(200);
    expect(flow.text).toContain("Fluxo Visual SDD");
    expect(flow.text).toContain("window.print()");
    await agent.post("/api/admin/workspace-bindings").send({}).expect(403);
    await agent.delete("/api/admin/session").set("x-csrf-token", restored.body.csrf).expect(204);
    await agent.get("/api/admin/session").expect(401);
  });

  it("protects MCP and completes a Streamable HTTP initialize request", async () => {
    const { server, callLogs } = application();
    await request(server.app).post("/mcp").send({ method: "tools/list" }).expect(401);
    const response = await request(server.app)
      .post("/mcp")
      .set("Authorization", "Bearer test-bearer-token")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      })
      .expect(200);
    const sessionId = response.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTypeOf("string");

    const headers = {
      Authorization: "Bearer test-bearer-token",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-03-26",
    };
    await request(server.app).post("/mcp").set(headers).send({ jsonrpc: "2.0", method: "notifications/initialized" }).expect(202);
    const tools = await request(server.app).post("/mcp").set(headers).send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).expect(200);
    expect(mcpPayload(tools).result.tools.map((tool: { name: string }) => tool.name)).toContain("jira_help");
    expect(mcpPayload(tools).result.tools.map((tool: { name: string }) => tool.name)).toContain("jira_add_comment");
    expect(mcpPayload(tools).result.tools.map((tool: { name: string }) => tool.name)).toContain("jira_record_sdd_event");
    expect(mcpPayload(tools).result.tools.map((tool: { name: string }) => tool.name)).toContain("jira_link_issues");
    expect(mcpPayload(tools).result.tools.map((tool: { name: string }) => tool.name)).not.toContain("cloud_task");
    const help = await request(server.app).post("/mcp").set(headers).send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jira_help", arguments: {} } }).expect(200);
    expect(mcpPayload(help).result.content[0].text).toContain("jira_create_task");
    const sddPreview = await request(server.app).post("/mcp").set(headers).send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sdd_init", arguments: { workspacePath: process.cwd() } } }).expect(200);
    expect(mcpPayload(sddPreview).result.content[0].text).toContain('"action": "preview"');
    expect(callLogs.list().some((log) => log.protocolMethod === "initialize")).toBe(true);
    expect(callLogs.list().some((log) => log.httpStatus === 401)).toBe(true);
  });
});

function mcpPayload(response: request.Response) {
  if (response.body?.result) return response.body;
  const data = response.text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error(`Missing MCP payload: ${response.text}`);
  return JSON.parse(data);
}
