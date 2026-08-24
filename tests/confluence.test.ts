import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfluenceClient, mermaidMacro } from "../src/confluence-client.js";
import { ConfluenceService, type JiraProfileService, type WorkspaceService } from "../src/services.js";
import { loadSddCatalog } from "../src/sdd-catalog.js";

afterEach(() => vi.restoreAllMocks());

const profile = { baseUrl: "https://cloud.atlassian.net", email: "user@example.com" };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("ConfluenceClient", () => {
  it("authenticates with Basic auth against the /wiki v2 API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "S1", key: "~acc", name: "Personal" }] }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "P1", title: "Amora", status: "current" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const { spaceId, page } = await new ConfluenceClient(profile, "token").findPage("~acc", "Amora");

    expect(spaceId).toBe("S1");
    expect(page?.id).toBe("P1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://cloud.atlassian.net/wiki/api/v2/spaces?keys=~acc&limit=250");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cloud.atlassian.net/wiki/api/v2/pages?space-id=S1&title=Amora&limit=1");
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("user@example.com:token").toString("base64")}`);
  });

  it("increments the version number when updating a page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "P1", title: "Old", status: "current", version: { number: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ id: "P1", title: "New", status: "current", version: { number: 4 } }));
    vi.stubGlobal("fetch", fetchMock);

    await new ConfluenceClient(profile, "token").updatePage({ pageId: "P1", title: "New", body: "<p>x</p>" });

    expect(fetchMock.mock.calls[1][0]).toBe("https://cloud.atlassian.net/wiki/api/v2/pages/P1");
    const request = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(request.version.number).toBe(4);
    expect(request.body).toEqual({ representation: "storage", value: "<p>x</p>" });
  });

  it("sends spaceId, parentId and storage body when creating a page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "P2" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await new ConfluenceClient(profile, "token").createPage({ spaceId: "S1", title: "amora-api", body: "<p>y</p>", parentId: "P1" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://cloud.atlassian.net/wiki/api/v2/pages");
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request).toMatchObject({ spaceId: "S1", parentId: "P1", status: "current", title: "amora-api", body: { representation: "storage", value: "<p>y</p>" } });
  });

  it("maps HTTP failures to typed Confluence errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "no access" }, 403)));
    await expect(new ConfluenceClient(profile, "token").getPage("P1")).rejects.toMatchObject({ code: "CONFLUENCE_AUTH_FAILED", status: 403 });
  });

  it("wraps diagrams in the mermaidjs macro with a JSON diagramDefinition body", () => {
    const macro = mermaidMacro('flowchart LR\n  A["x"]-->B', { theme: "dark" });
    expect(macro).toContain('ac:name="mermaidjs"');
    expect(macro).toContain('<ac:parameter ac:name="theme">dark</ac:parameter>');
    expect(macro).toContain('<ac:parameter ac:name="version">2</ac:parameter>');
    const cdata = macro.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1];
    expect(JSON.parse(cdata).diagramDefinition).toBe('flowchart LR\n  A["x"]-->B');
  });

  it("is deterministic so an unchanged diagram produces identical storage", () => {
    const diagram = "graph TD; A-->B";
    expect(mermaidMacro(diagram)).toBe(mermaidMacro(diagram));
    expect(mermaidMacro(diagram, { theme: "dark" })).not.toBe(mermaidMacro(diagram));
    expect(mermaidMacro(diagram)).not.toBe(mermaidMacro("graph TD; A-->C"));
  });
});

describe("ConfluenceService", () => {
  it("resolves the workspace binding and reports page existence", async () => {
    const client = {
      findPage: vi.fn().mockResolvedValue({ spaceId: "S1", page: { id: "P1" } }),
      getSpaceIdByKey: vi.fn(), createPage: vi.fn(), updatePage: vi.fn(), listSpaces: vi.fn(), getPage: vi.fn(),
    };
    const profiles = { confluenceClient: vi.fn().mockReturnValue(client) } as unknown as JiraProfileService;
    const resolve = vi.fn().mockReturnValue({ jiraProfileId: "cloud" });
    const workspaces = { resolve } as unknown as WorkspaceService;
    const service = new ConfluenceService(profiles, workspaces);

    const found = await service.findPage("/abs/ws", "~acc", "Amora");

    expect(resolve).toHaveBeenCalledWith("/abs/ws");
    expect(client.findPage).toHaveBeenCalledWith("~acc", "Amora");
    expect(found).toEqual({ spaceId: "S1", exists: true, page: { id: "P1" } });
  });

  it("reports absence when no page matches", async () => {
    const client = { findPage: vi.fn().mockResolvedValue({ spaceId: "S1", page: undefined }) };
    const profiles = { confluenceClient: () => client } as unknown as JiraProfileService;
    const workspaces = { resolve: () => ({ jiraProfileId: "cloud" }) } as unknown as WorkspaceService;

    const found = await new ConfluenceService(profiles, workspaces).findPage("/abs/ws", "~acc", "Ghost");

    expect(found).toEqual({ spaceId: "S1", exists: false, page: null });
  });
});

describe("SDD catalog with sdd-doc", () => {
  it("loads and expands the sdd-doc command, agent and partial", () => {
    const catalog = loadSddCatalog(resolve("resources/sdd"));
    const command = catalog.commands.get("sdd-doc");
    const agent = catalog.agents.get("sdd-doc-writer");

    expect(command?.target).toBe(".claude/commands/sdd-doc.md");
    expect(agent?.target).toBe(".claude/agents/sdd-doc-writer.md");
    expect(command?.content).not.toContain("<!-- sdd:partial");
    expect(agent?.content).not.toContain("<!-- sdd:partial");
    expect(command?.content).toContain("Pagina-HUB");
  });
});
