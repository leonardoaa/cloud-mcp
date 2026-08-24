import { createHash } from "node:crypto";
import type { JiraProfile } from "./domain.js";
import { AppError } from "./domain.js";

type FetchOptions = RequestInit & { timeoutMs?: number };
type Representation = "storage" | "atlas_doc_format" | "wiki";

export type ConfluenceSpace = { id: string; key: string; name: string; type?: string };
export type ConfluencePage = {
  id: string;
  status: string;
  title: string;
  spaceId?: string;
  parentId?: string;
  version?: { number: number };
  body?: Record<string, { value: string; representation: string }>;
  _links?: Record<string, string>;
};

export class ConfluenceClient {
  constructor(
    private readonly profile: Pick<JiraProfile, "baseUrl" | "email">,
    private readonly token: string,
  ) {}

  async listSpaces(keys?: string[]) {
    const query = keys?.length ? `?keys=${keys.map((key) => encodeURIComponent(key)).join(",")}&limit=250` : "?limit=250";
    const data = await this.request<{ results?: ConfluenceSpace[] }>(`/api/v2/spaces${query}`);
    return data.results ?? [];
  }

  async getSpaceIdByKey(spaceKey: string) {
    const spaces = await this.listSpaces([spaceKey]);
    const match = spaces.find((space) => space.key === spaceKey);
    if (!match) throw new AppError("CONFLUENCE_SPACE_NOT_FOUND", `Confluence space ${spaceKey} was not found`, 404);
    return match.id;
  }

  async findPage(spaceKey: string, title: string) {
    const spaceId = await this.getSpaceIdByKey(spaceKey);
    const data = await this.request<{ results?: ConfluencePage[] }>(
      `/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}&limit=1`,
    );
    return { spaceId, page: data.results?.[0] };
  }

  async getPage(pageId: string, bodyFormat: Representation = "storage") {
    return this.request<ConfluencePage>(`/api/v2/pages/${encodeURIComponent(pageId)}?body-format=${bodyFormat}`);
  }

  async createPage(input: { spaceId: string; title: string; body: string; parentId?: string; representation?: Representation }) {
    const payload = {
      spaceId: input.spaceId,
      status: "current",
      title: input.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      body: { representation: input.representation ?? "storage", value: input.body },
    };
    return this.request<ConfluencePage>("/api/v2/pages", { method: "POST", body: JSON.stringify(payload) });
  }

  async updatePage(input: { pageId: string; title: string; body: string; representation?: Representation; versionMessage?: string }) {
    const current = await this.getPage(input.pageId);
    const nextVersion = (current.version?.number ?? 0) + 1;
    const payload = {
      id: input.pageId,
      status: "current",
      title: input.title,
      body: { representation: input.representation ?? "storage", value: input.body },
      version: { number: nextVersion, ...(input.versionMessage ? { message: input.versionMessage } : {}) },
    };
    return this.request<ConfluencePage>(`/api/v2/pages/${encodeURIComponent(input.pageId)}`, { method: "PUT", body: JSON.stringify(payload) });
  }

  private async request<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.rawRequest(path, options);
    if (!response.ok) throw await confluenceError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async rawRequest(path: string, options: FetchOptions = {}) {
    const { timeoutMs = 30_000, headers, ...rest } = options;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Accept", requestHeaders.get("Accept") ?? "application/json");
    requestHeaders.set("Authorization", `Basic ${Buffer.from(`${this.profile.email}:${this.token}`).toString("base64")}`);
    if (!(rest.body instanceof FormData) && !requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
    try {
      return await fetch(`${this.profile.baseUrl}/wiki${path}`, {
        ...rest,
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
        headers: requestHeaders,
      });
    } catch {
      throw new AppError("CONFLUENCE_UNAVAILABLE", "Confluence is temporarily unavailable", 503, { transient: true });
    }
  }
}

async function confluenceError(response: Response) {
  let details: unknown;
  try { details = await response.json(); } catch { details = await response.text(); }
  const transient = response.status === 429 || response.status >= 500;
  const code = response.status === 401 || response.status === 403 ? "CONFLUENCE_AUTH_FAILED"
    : response.status === 404 ? "CONFLUENCE_PAGE_NOT_FOUND"
    : response.status === 429 ? "CONFLUENCE_RATE_LIMITED"
    : response.status >= 500 ? "CONFLUENCE_UNAVAILABLE"
    : "CONFLUENCE_REQUEST_FAILED";
  return new AppError(code, `Confluence returned HTTP ${response.status}`, response.status, { response: details, transient, retryAfter: response.headers.get("retry-after") ?? undefined });
}

/** Deterministic UUID-shaped id derived from a seed, so re-runs stay stable. */
function stableId(seed: string) {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Wraps a Mermaid diagram in the `mermaidjs` Confluence macro (from the Mermaid
 * app installed on the site) so it renders instead of showing as code.
 * The macro body is a JSON object `{ diagramDefinition }`, not raw Mermaid.
 * fileName and the macro ids are derived from the diagram so re-generating an
 * unchanged diagram produces byte-identical storage (no spurious diffs).
 */
export function mermaidMacro(diagram: string, options: { theme?: "default" | "dark" | "neutral" | "forest"; fileName?: string } = {}) {
  const theme = options.theme ?? "default";
  const hash = createHash("sha256").update(`${theme}\n${diagram}`).digest("hex");
  const fileName = options.fileName ?? `mermaid_${hash.slice(0, 16)}`;
  const payload = JSON.stringify({ diagramDefinition: diagram });
  return `<ac:structured-macro ac:name="mermaidjs" ac:schema-version="1" data-layout="default" ac:local-id="${stableId(`${hash}|local`)}" ac:macro-id="${stableId(`${hash}|macro`)}"><ac:parameter ac:name="fileName">${fileName}</ac:parameter><ac:parameter ac:name="theme">${theme}</ac:parameter><ac:parameter ac:name="version">2</ac:parameter><ac:plain-text-body><![CDATA[${payload}]]></ac:plain-text-body></ac:structured-macro>`;
}
