import { afterEach, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { openDatabase } from "../src/database.js";
import { downloadAttachment, readLimitedBody, JiraClient } from "../src/jira-client.js";
import { ConfluenceClient } from "../src/confluence-client.js";
import type { JiraProfile } from "../src/domain.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(["MCP_SERVER_BEARER_TOKEN", "MCP_ADMIN_PASSWORD", "JIRA_CREDENTIALS_MASTER_KEY"])("rejects server secret reference %s", (name) => {
  const db = openDatabase(":memory:");
  try {
    vi.stubEnv(name, "synthetic-server-secret");
    expect(() => new CredentialStore(db).resolve(`env:${name}`)).toThrow("Server secrets cannot be used");
    vi.stubEnv("JIRA_TEST_TOKEN", "synthetic-jira-token");
    expect(new CredentialStore(db).resolve("env:JIRA_TEST_TOKEN")).toBe("synthetic-jira-token");
  } finally { db.close(); }
});

it.each(["https://127.0.0.1/private", "http://api.media.atlassian.com/file", "https://api.media.atlassian.com.evil.test/file", "https://user:password@api.media.atlassian.com/file"])("blocks unsafe attachment destination %s", async (url) => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  await expect(downloadAttachment(url, "https://test.atlassian.net")).rejects.toThrow("Untrusted attachment redirect");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("validates every redirect and downloads media without credentials", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://api.media.atlassian.com/file" } }))
    .mockResolvedValueOnce(new Response("ok"));
  expect(await (await downloadAttachment("/download", "https://test.atlassian.net")).text()).toBe("ok");
  for (const [, options] of fetchMock.mock.calls) {
    expect(options?.headers).toBeUndefined();
    expect(options?.redirect).toBe("manual");
  }
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }));
  await expect(downloadAttachment("/download", "https://test.atlassian.net")).rejects.toThrow("Untrusted");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("enforces attachment size while streaming regardless of metadata", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel }));
  await expect(readLimitedBody(response, 4)).rejects.toThrow("Attachment exceeds");
  expect(cancel).toHaveBeenCalled();
  expect((await readLimitedBody(new Response("okay"), 4)).toString()).toBe("okay");
});

it("does not follow authenticated API redirects and preserves non-JSON errors", async () => {
  const profile = { baseUrl: "https://test.atlassian.net", email: "user@example.com" } as JiraProfile;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream unavailable", { status: 503 }));
  await expect(new JiraClient(profile, "synthetic-jira-token").myself()).rejects.toMatchObject({ code: "JIRA_UNAVAILABLE" });
  await expect(new ConfluenceClient(profile, "synthetic-jira-token").listSpaces()).rejects.toMatchObject({ code: "CONFLUENCE_UNAVAILABLE" });
  for (const [, options] of fetchMock.mock.calls) expect(options?.redirect).toBe("error");
});
