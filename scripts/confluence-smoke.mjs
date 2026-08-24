#!/usr/bin/env node
// Smoke test do fluxo Confluence sobre o MCP Streamable HTTP.
//
// Uso:
//   MCP_SERVER_BEARER_TOKEN=... node scripts/confluence-smoke.mjs
//
// Variaveis opcionais:
//   MCP_URL        (default http://127.0.0.1:37242/mcp)
//   WORKSPACE      caminho do workspace no servidor (ex.: /workspaces/cloud-amora-api)
//   SPACE_KEY      chave do space Confluence para testar find_page (ex.: ~5df7...)
//   PAGE_TITLE     titulo da pagina para find_page
//
// O script apenas LE (initialize, tools/list, jira_list_profiles,
// jira_get_workspace_binding, confluence_list_spaces, confluence_find_page).
// Nao cria nem altera nenhuma pagina.

const URL = process.env.MCP_URL ?? "http://127.0.0.1:37242/mcp";
const TOKEN = process.env.MCP_SERVER_BEARER_TOKEN;
const WORKSPACE = process.env.WORKSPACE;
const SPACE_KEY = process.env.SPACE_KEY;
const PAGE_TITLE = process.env.PAGE_TITLE;
const PROTOCOL = "2025-03-26";

if (!TOKEN) {
  console.error("Falta MCP_SERVER_BEARER_TOKEN no ambiente.");
  process.exit(2);
}

let sessionId;

function parseBody(status, text, contentType) {
  if (!text) return undefined;
  if (contentType?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    if (!line) throw new Error(`Resposta SSE sem data (HTTP ${status}): ${text.slice(0, 200)}`);
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

async function rpc(method, params, id) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": PROTOCOL,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const returnedSession = res.headers.get("mcp-session-id");
  if (returnedSession) sessionId = returnedSession;
  const text = await res.text();
  const payload = parseBody(res.status, text, res.headers.get("content-type"));
  return { status: res.status, payload };
}

async function callTool(name, args) {
  const { payload } = await rpc("tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const text = payload?.result?.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed?.data ?? parsed?.error ?? payload?.error ?? parsed;
}

function line() { console.log("-".repeat(60)); }

(async () => {
  const init = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "confluence-smoke", version: "1" } }, 1);
  if (init.status !== 200 || !sessionId) {
    console.error(`initialize falhou: HTTP ${init.status}`, JSON.stringify(init.payload));
    process.exit(1);
  }
  await rpc("notifications/initialized", {});
  console.log(`✓ Conectado ao MCP (${URL}), sessao ${sessionId.slice(0, 8)}...`);

  line();
  const tools = (await rpc("tools/list", {}, 2)).payload.result.tools.map((t) => t.name);
  const confluenceTools = tools.filter((t) => t.startsWith("confluence_"));
  console.log(`Tools Confluence disponiveis (${confluenceTools.length}/5):`, confluenceTools.join(", ") || "NENHUMA");
  if (confluenceTools.length < 5) {
    console.log("⚠ As tools confluence_* nao estao no servidor rodando — rebuild/restart do container necessario.");
  }

  line();
  const profiles = await callTool("jira_list_profiles", {});
  const list = profiles?.profiles ?? [];
  console.log(`Perfis Jira (${list.length}):`);
  for (const p of list) console.log(`  - ${p.id} | ${p.name} | ${p.baseUrl} | ${p.emailMasked ?? p.email ?? ""}`);

  if (WORKSPACE) {
    line();
    const binding = await callTool("jira_get_workspace_binding", { workspacePath: WORKSPACE });
    if (binding?.jiraProfileId) {
      console.log(`Binding de ${WORKSPACE}: perfil=${binding.jiraProfileId} projeto=${binding.jiraProjectKey}`);
    } else {
      console.log(`Sem binding para ${WORKSPACE}:`, JSON.stringify(binding));
    }

    if (confluenceTools.includes("confluence_list_spaces") && binding?.jiraProfileId) {
      line();
      const spaces = await callTool("confluence_list_spaces", { workspacePath: WORKSPACE });
      if (Array.isArray(spaces)) {
        console.log(`Spaces Confluence (${spaces.length}):`);
        for (const s of spaces.slice(0, 30)) console.log(`  - ${s.key} | ${s.id} | ${s.name}`);
      } else {
        console.log("confluence_list_spaces retornou:", JSON.stringify(spaces));
      }

      if (SPACE_KEY && PAGE_TITLE) {
        line();
        const found = await callTool("confluence_find_page", { workspacePath: WORKSPACE, spaceKey: SPACE_KEY, title: PAGE_TITLE });
        console.log(`find_page(${SPACE_KEY}, "${PAGE_TITLE}"):`, JSON.stringify(found));
      }
    }
  } else {
    line();
    console.log("Defina WORKSPACE=/workspaces/<projeto> para testar binding + confluence_list_spaces.");
  }

  line();
  console.log("Smoke test concluido.");
})().catch((err) => {
  console.error("Erro no smoke test:", err.message);
  process.exit(1);
});
