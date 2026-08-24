import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, CallLog, JiraProfile, SddCard, SddCardColumn, SddCommandKind, SddRunnerProfile, SddTerminalSession, setCsrf, WorkspaceBinding } from "./api";

type Page = "jiras" | "workspaces" | "issues" | "sdd" | "logs";
type AdminSession = { csrf: string; expiresAt: number };

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [page, setPage] = useState<Page>("jiras");
  useEffect(() => {
    api<AdminSession>("/session")
      .then((session) => {
        setCsrf(session.csrf);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setCheckingSession(false));
  }, []);
  if (checkingSession) return <div className="login"><div className="panel login-panel"><div className="brand large"><span>C</span><div><strong>Cloud</strong><small>Jira MCP Console</small></div></div><h1>Restaurando sessão</h1><p>Validando acesso administrativo...</p></div></div>;
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  return (
    <div className="shell">
      <aside>
        <div className="brand"><span>C</span><div><strong>Cloud</strong><small>Jira MCP Console</small></div></div>
        <nav>
          <Nav active={page === "jiras"} onClick={() => setPage("jiras")} label="Jiras" />
          <Nav active={page === "workspaces"} onClick={() => setPage("workspaces")} label="Workspaces" />
          <Nav active={page === "sdd"} onClick={() => setPage("sdd")} label="SDD Kanban" />
          <Nav active={page === "issues"} onClick={() => setPage("issues")} label="Issues" />
          <Nav active={page === "logs"} onClick={() => setPage("logs")} label="Logs MCP" />
          <Nav active={false} onClick={() => window.open("/api/admin/sdd-flow-print", "_blank", "noopener,noreferrer")} label="Fluxo SDD" />
        </nav>
        <div className="server-state"><i /> Streamable HTTP ativo</div>
      </aside>
      <main>
        {page === "jiras" && <JirasPage />}
        {page === "workspaces" && <WorkspacesPage />}
        {page === "issues" && <IssuesPage />}
        {page === "sdd" && <SddKanbanPage />}
        {page === "logs" && <LogsPage />}
      </main>
    </div>
  );
}

const sddColumns: Array<{ id: SddCardColumn; label: string }> = [
  { id: "sdd-task", label: "SDD Task" },
  { id: "planning", label: "Planejamento" },
  { id: "sdd-build", label: "SDD Build" },
  { id: "blocked", label: "Bloqueado" },
  { id: "done", label: "Concluido" },
];

const terminalKeys: Array<{ label: string; value: string; title: string; danger?: boolean }> = [
  { label: "↑", value: "\x1b[A", title: "Seta para cima" },
  { label: "↓", value: "\x1b[B", title: "Seta para baixo" },
  { label: "←", value: "\x1b[D", title: "Seta para esquerda" },
  { label: "→", value: "\x1b[C", title: "Seta para direita" },
  { label: "Enter", value: "\r", title: "Selecionar / confirmar" },
  { label: "Tab", value: "\t", title: "Alternar foco/opcao" },
  { label: "Esc", value: "\x1b", title: "Cancelar / voltar" },
  { label: "Espaco", value: " ", title: "Marcar opcao" },
  { label: "Ctrl+C", value: "\x03", title: "Interromper processo", danger: true },
];

function SddKanbanPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceBinding[]>([]);
  const [profiles, setProfiles] = useState<SddRunnerProfile[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [cards, setCards] = useState<SddCard[]>([]);
  const [activeColumn, setActiveColumn] = useState<SddCardColumn>("sdd-task");
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ title: "", requestText: "", runnerProfileId: "claude-default" as SddRunnerProfile["id"] });

  useEffect(() => {
    Promise.all([api<WorkspaceBinding[]>("/workspace-bindings"), api<SddRunnerProfile[]>("/sdd/runner-profiles")])
      .then(([workspaceItems, runnerItems]) => {
        setWorkspaces(workspaceItems);
        setProfiles(runnerItems);
        setWorkspaceId((current) => current || workspaceItems[0]?.workspaceId || "");
      })
      .catch((e) => setError(message(e)));
  }, []);

  const loadCards = () => {
    if (!workspaceId) { setCards([]); return Promise.resolve(); }
    return api<SddCard[]>(`/sdd/cards?workspaceId=${encodeURIComponent(workspaceId)}`).then(setCards).catch((e) => setError(message(e)));
  };
  useEffect(() => { void loadCards(); }, [workspaceId]);

  async function create(e: FormEvent) {
    e.preventDefault(); setError(""); setNotice("");
    try {
      const card = await api<SddCard>("/sdd/cards", { method: "POST", body: JSON.stringify({ workspaceId, ...form }) });
      setForm({ title: "", requestText: "", runnerProfileId: "claude-default" });
      setExpanded(card.id);
      await loadCards();
    } catch (reason) { setError(message(reason)); }
  }

  async function patchCard(card: SddCard, patch: Partial<Pick<SddCard, "title" | "requestText" | "jiraIssueKey" | "runnerProfileId">>) {
    setError(""); setNotice("");
    try {
      await api(`/sdd/cards/${card.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadCards();
    } catch (reason) { setError(message(reason)); }
  }

  async function move(card: SddCard, column: SddCardColumn) {
    setError(""); setNotice("");
    try {
      const moved = await api<SddCard>(`/sdd/cards/${card.id}/move`, { method: "POST", body: JSON.stringify({ column }) });
      setExpanded(card.id);
      setActiveColumn(column);
      await loadCards();
      if (column === "planning" || column === "sdd-build") setNotice(`${moved.title}: pronto para iniciar ${column === "planning" ? "/sdd-plan" : "/sdd-build"}.`);
    } catch (reason) { setError(message(reason)); }
  }

  async function start(card: SddCard, commandKind?: SddCommandKind) {
    const profile = profiles.find((item) => item.id === card.runnerProfileId);
    if (profile?.requiresStrongConfirmation && !confirm(`Iniciar ${profile.label} com permissões elevadas neste card?`)) return;
    setError(""); setNotice("");
    try {
      await api<SddTerminalSession>(`/sdd/cards/${card.id}/sessions`, { method: "POST", body: JSON.stringify({ commandKind, confirmedDanger: Boolean(profile?.requiresStrongConfirmation) }) });
      setExpanded(card.id);
      await loadCards();
    } catch (reason) { setError(message(reason)); }
  }

  const selectedWorkspace = workspaces.find((item) => item.workspaceId === workspaceId);
  return (
    <>
      <Header eyebrow="SDD" title="Kanban SDD" subtitle="Cards locais com terminal Claude interativo no workspace vinculado." action={<select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>{workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.workspaceName ?? item.canonicalPath}</option>)}</select>} />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert">{notice}</div>}
      <div className="alert sdd-runtime-note">
        Com Docker, mantenha o host runner ativo no Mac. Use `./scripts/install-host-runner-launch-agent.sh` para iniciar automaticamente no login.
      </div>
      {!workspaces.length && <Empty text="Nenhum workspace vinculado." />}
      {selectedWorkspace && <div className="workspace-note"><strong>{selectedWorkspace.workspaceName}</strong><span>{selectedWorkspace.canonicalPath}</span></div>}
      {workspaceId && <form className="panel sdd-create" onSubmit={create}>
        <label>Título<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
        <label>Perfil<select value={form.runnerProfileId} onChange={(e) => setForm({ ...form, runnerProfileId: e.target.value as SddRunnerProfile["id"] })}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
        <label className="wide">Demanda<textarea value={form.requestText} onChange={(e) => setForm({ ...form, requestText: e.target.value })} placeholder="Descreva a tarefa para o /sdd-task" /></label>
        <button className="primary">Criar card</button>
      </form>}
      <div className="sdd-tabs">{sddColumns.map((column) => <button key={column.id} className={activeColumn === column.id ? "active" : ""} onClick={() => setActiveColumn(column.id)}>{column.label}<span>{cards.filter((card) => card.column === column.id).length}</span></button>)}</div>
      <section className="sdd-board">
        {sddColumns.map((column) => <div className={`sdd-column ${activeColumn === column.id ? "mobile-active" : ""}`} key={column.id}>
          <div className="sdd-column-head"><h2>{column.label}</h2><span>{cards.filter((card) => card.column === column.id).length}</span></div>
          <div className="sdd-card-list">
            {cards.filter((card) => card.column === column.id).map((card) => <SddCardView key={card.id} card={card} profiles={profiles} expanded={expanded === card.id} onExpand={() => setExpanded(expanded === card.id ? undefined : card.id)} onPatch={patchCard} onMove={move} onStart={start} onRefresh={loadCards} />)}
            {!cards.some((card) => card.column === column.id) && <div className="sdd-empty">Sem cards.</div>}
          </div>
        </div>)}
      </section>
    </>
  );
}

function SddCardView({ card, profiles, expanded, onExpand, onPatch, onMove, onStart, onRefresh }: {
  card: SddCard;
  profiles: SddRunnerProfile[];
  expanded: boolean;
  onExpand: () => void;
  onPatch: (card: SddCard, patch: Partial<Pick<SddCard, "title" | "requestText" | "jiraIssueKey" | "runnerProfileId">>) => Promise<void>;
  onMove: (card: SddCard, column: SddCardColumn) => Promise<void>;
  onStart: (card: SddCard, commandKind?: SddCommandKind) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const latest = card.sessions?.[0];
  const commandKind = card.column === "planning" ? "sdd-plan" : card.column === "sdd-build" ? "sdd-build" : "sdd-task";
  const [draft, setDraft] = useState({ title: card.title, requestText: card.requestText, jiraIssueKey: card.jiraIssueKey ?? "", runnerProfileId: card.runnerProfileId });
  useEffect(() => setDraft({ title: card.title, requestText: card.requestText, jiraIssueKey: card.jiraIssueKey ?? "", runnerProfileId: card.runnerProfileId }), [card.id, card.title, card.requestText, card.jiraIssueKey, card.runnerProfileId]);
  const saveDraft = () => void onPatch(card, {
    title: draft.title,
    requestText: draft.requestText,
    jiraIssueKey: draft.jiraIssueKey,
    runnerProfileId: draft.runnerProfileId,
  });
  return <article className={`sdd-card ${expanded ? "expanded" : ""}`}>
    <button className="sdd-card-summary" onClick={onExpand}>
      <span className={`badge ${card.status === "running" ? "running" : card.status === "blocked" ? "error" : card.status === "done" ? "success" : "muted"}`}>{card.status}</span>
      <strong>{card.title}</strong>
      {card.jiraIssueKey && <code>{card.jiraIssueKey}</code>}
    </button>
    {expanded && <div className="sdd-card-body">
      <label>Título<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onBlur={saveDraft} /></label>
      <label>Issue Jira<input value={draft.jiraIssueKey} onChange={(e) => setDraft({ ...draft, jiraIssueKey: e.target.value })} onBlur={saveDraft} placeholder="PROJ-123" /></label>
      <label>Perfil Claude<select value={draft.runnerProfileId} onChange={(e) => { const runnerProfileId = e.target.value as SddRunnerProfile["id"]; setDraft({ ...draft, runnerProfileId }); void onPatch(card, { runnerProfileId }); }}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}{profile.requiresStrongConfirmation ? " (confirmação)" : ""}</option>)}</select></label>
      <label className="wide">Demanda<textarea value={draft.requestText} onChange={(e) => setDraft({ ...draft, requestText: e.target.value })} onBlur={saveDraft} /></label>
      <div className="sdd-actions">
        <button className="primary" onClick={() => void onStart(card, commandKind)} disabled={card.status === "running"}>Iniciar {commandLabel(commandKind)}</button>
        {card.column !== "sdd-task" && <button onClick={() => void onMove(card, "sdd-task")}>Mover para SDD Task</button>}
        {card.column !== "planning" && <button onClick={() => void onMove(card, "planning")}>Mover para Planejamento</button>}
        {card.column !== "sdd-build" && <button onClick={() => void onMove(card, "sdd-build")}>Mover para SDD Build</button>}
        {card.column !== "done" && <button onClick={() => void onMove(card, "done")}>Concluir</button>}
        {card.column !== "blocked" && <button className="danger-link" onClick={() => void onMove(card, "blocked")}>Bloquear</button>}
      </div>
      {latest && <TerminalPanel session={latest} onRefresh={onRefresh} />}
    </div>}
  </article>;
}

function TerminalPanel({ session, onRefresh }: { session: SddTerminalSession; onRefresh: () => Promise<void> }) {
  const terminalNode = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const [input, setInput] = useState("");
  const sendTerminalData = (data: string) => api(`/sdd/sessions/${session.id}/input`, { method: "POST", body: JSON.stringify({ data }) });
  useEffect(() => {
    if (!terminalNode.current) return;
    terminal.current?.dispose();
    terminalNode.current.textContent = "";
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: session.status === "running",
      cursorStyle: "bar",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: window.matchMedia("(max-width: 850px)").matches ? 12 : 13,
      lineHeight: 1.25,
      rows: window.matchMedia("(max-width: 850px)").matches ? 32 : 24,
      scrollback: 3000,
      theme: {
        background: "#05080d",
        foreground: "#d8f7e7",
        cursor: "#50e3c2",
        selectionBackground: "#2b5f75",
        black: "#111827",
        red: "#ff8b98",
        green: "#5ce4ad",
        yellow: "#f5d766",
        blue: "#6bb8ff",
        magenta: "#d6a1ff",
        cyan: "#50e3c2",
        white: "#e8edf5",
        brightBlack: "#748197",
        brightRed: "#ffb3ba",
        brightGreen: "#91ffd0",
        brightYellow: "#ffe88a",
        brightBlue: "#9ed1ff",
        brightMagenta: "#e6c4ff",
        brightCyan: "#98f5e2",
        brightWhite: "#ffffff",
      },
    });
    term.open(terminalNode.current);
    terminal.current = term;

    let source: EventSource | undefined;
    let keyboardInput: { dispose(): void } | undefined;
    if (session.status === "running") {
      keyboardInput = term.onData((data) => {
        void api(`/sdd/sessions/${session.id}/input`, { method: "POST", body: JSON.stringify({ data }) });
      });
      source = new EventSource(`/api/admin/sdd/sessions/${session.id}/stream`);
      source.addEventListener("terminal", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { chunk: string };
        term.write(payload.chunk);
      });
      source.onerror = () => void onRefresh();
    } else {
      term.write(session.logTail || "Aguardando saída do terminal...\r\n");
    }

    return () => {
      keyboardInput?.dispose();
      source?.close();
      term.dispose();
      if (terminal.current === term) terminal.current = undefined;
    };
  }, [onRefresh, session.id, session.logTail, session.status]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!input) return;
    await sendTerminalData(`${input}\r`);
    setInput("");
  }
  async function stop() {
    if (!confirm("Parar esta sessão de terminal?")) return;
    await api(`/sdd/sessions/${session.id}/stop`, { method: "POST" });
    await onRefresh();
  }
  async function sendInitialCommand() {
    await api(`/sdd/sessions/${session.id}/initial-command`, { method: "POST" });
  }
  async function sendKey(data: string) {
    await sendTerminalData(data);
    terminal.current?.focus();
  }
  return <div className="terminal-panel">
    <div className="terminal-head">
      <div><strong>{session.commandText}</strong><small>{session.runnerLabel} · {session.status}</small></div>
      {session.status === "running" && <div className="terminal-tools"><button onClick={() => void sendInitialCommand()}>Forçar comando inicial</button><button className="danger-link" onClick={() => void stop()}>Parar</button></div>}
    </div>
    <div className="terminal-screen" ref={terminalNode} onClick={() => terminal.current?.focus()} />
    <div className="terminal-keypad">
      {terminalKeys.map((key) => <button key={key.label} type="button" className={key.danger ? "danger-link" : ""} title={key.title} aria-label={key.title} disabled={session.status !== "running"} onClick={() => void sendKey(key.value)}>{key.label}</button>)}
    </div>
    <form onSubmit={send} className="terminal-input"><input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Digite uma resposta para o terminal" disabled={session.status !== "running"} /><button disabled={session.status !== "running"}>Enviar</button></form>
  </div>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try { const result = await api<{ csrf: string }>("/session", { method: "POST", body: JSON.stringify({ password }) }); setCsrf(result.csrf); setPassword(""); onLogin(); }
    catch (reason) { setError(message(reason)); }
  }
  return <div className="login"><form onSubmit={submit} className="panel login-panel"><div className="brand large"><span>C</span><div><strong>Cloud</strong><small>Jira MCP Console</small></div></div><h1>Acesso administrativo</h1><p>Gerencie conexões Jira, workspaces e chamadas MCP.</p><label>Senha<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <div className="alert error">{error}</div>}<button className="primary">Entrar</button></form></div>;
}

function JirasPage() {
  const [profiles, setProfiles] = useState<JiraProfile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JiraProfile>();
  const [notice, setNotice] = useState("");
  const load = () => api<JiraProfile[]>("/jira-profiles").then(setProfiles).catch((e) => setNotice(message(e)));
  useEffect(() => { void load(); }, []);
  async function test(id: string) { setNotice("Testando conexão..."); try { const result = await api<{ projects: number }>(`/jira-profiles/${id}/test`, { method: "POST" }); setNotice(`Conexão validada. ${result.projects} projeto(s) acessível(is).`); } catch (e) { setNotice(message(e)); } }
  async function disable(profile: JiraProfile) { if (!confirm(`Desabilitar ${profile.name}? Workspaces vinculados deixarão de operar.`)) return; await api(`/jira-profiles/${profile.id}/disable`, { method: "POST" }); void load(); }
  return <><Header eyebrow="Configuração" title="Instâncias Jira" subtitle="Conexões disponíveis para os agentes e workspaces." action={<button className="primary" onClick={() => setShowForm(true)}>Adicionar Jira</button>} />{notice && <div className="alert">{notice}</div>}<section className="grid cards">{profiles.map((profile) => <article className="panel jira-card" key={profile.id}><div className="card-head"><div className="avatar">{profile.name[0]}</div><div><h3>{profile.name}</h3><a href={profile.baseUrl} target="_blank">{profile.baseUrl.replace("https://", "")}</a></div><span className={`badge ${profile.enabled ? "success" : "muted"}`}>{profile.enabled ? "Ativo" : "Inativo"}</span></div><dl><div><dt>Conta</dt><dd>{profile.emailMasked}</dd></div><div><dt>Projeto padrão</dt><dd>{profile.defaultProjectKey ?? "Não definido"}</dd></div><div><dt>Subtask</dt><dd>{profile.subtaskIssueType ?? "Subtask"}</dd></div></dl><div className="actions"><button onClick={() => void test(profile.id)}>Testar conexão</button><button onClick={() => setEditing(profile)}>Editar</button>{profile.enabled && <button className="danger-link" onClick={() => void disable(profile)}>Desabilitar</button>}</div></article>)}{!profiles.length && <Empty text="Nenhum Jira configurado." />}</section>{showForm && <JiraDialog onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); void load(); }} />}{editing && <JiraDialog profile={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void load(); }} />}</>;
}

function JiraDialog({ profile, onClose, onSaved }: { profile?: JiraProfile; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    id: profile?.id ?? "",
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    email: profile?.email ?? "",
    apiToken: "",
    defaultProjectKey: profile?.defaultProjectKey ?? "",
    subtaskIssueType: profile?.subtaskIssueType ?? "Subtask",
    statusInProgress: profile?.statusAliases.inProgress ?? "",
    statusCodeReview: profile?.statusAliases.codeReview ?? "",
    statusDone: profile?.statusAliases.done ?? "",
  });
  const [customFields, setCustomFields] = useState<Array<{ logicalName: string; jiraFieldId: string }>>(
    Object.entries(profile?.customFieldMap ?? {}).map(([logicalName, jiraFieldId]) => ({ logicalName, jiraFieldId })),
  );
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const change = (key: string, value: string) => setForm((state) => ({ ...state, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const payload = {
      name: form.name,
      baseUrl: form.baseUrl,
      email: form.email,
      defaultProjectKey: form.defaultProjectKey || undefined,
      subtaskIssueType: form.subtaskIssueType || undefined,
      statusAliases: {
        ...(form.statusInProgress ? { inProgress: form.statusInProgress } : {}),
        ...(form.statusCodeReview ? { codeReview: form.statusCodeReview } : {}),
        ...(form.statusDone ? { done: form.statusDone } : {}),
      },
      customFieldMap: Object.fromEntries(
        customFields
          .map((item) => ({ logicalName: item.logicalName.trim(), jiraFieldId: item.jiraFieldId.trim() }))
          .filter((item) => item.logicalName && item.jiraFieldId)
          .map((item) => [item.logicalName, item.jiraFieldId]),
      ),
    };
    try {
      if (profile) {
        await api(`/jira-profiles/${profile.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        if (form.apiToken) await api(`/jira-profiles/${profile.id}/rotate-credential`, { method: "POST", body: JSON.stringify({ apiToken: form.apiToken }) });
      } else {
        await api("/jira-profiles", { method: "POST", body: JSON.stringify({ id: form.id, apiToken: form.apiToken, ...payload }) });
      }
      onSaved();
    } catch (e) { setError(message(e)); }
    finally { setSaving(false); change("apiToken", ""); }
  }
  function updateCustomField(index: number, key: "logicalName" | "jiraFieldId", value: string) { setCustomFields((items) => items.map((item, current) => current === index ? { ...item, [key]: value } : item)); }
  function removeCustomField(index: number) { setCustomFields((items) => items.filter((_item, current) => current !== index)); }
  return <div className="modal"><form className="panel dialog" onSubmit={submit}><div className="dialog-head"><div><small>{profile ? "EDITAR CONEXÃO" : "NOVA CONEXÃO"}</small><h2>{profile ? profile.name : "Adicionar Jira"}</h2></div><button type="button" className="icon" onClick={onClose}>×</button></div><div className="form-grid"><label>Nome<input value={form.name} onChange={(e) => { change("name", e.target.value); if (!form.id) change("id", slug(e.target.value)); }} required /></label><label>ID<input value={form.id} onChange={(e) => change("id", e.target.value)} required disabled={Boolean(profile)} /></label><label className="wide">URL do Jira<input type="url" placeholder="https://empresa.atlassian.net" value={form.baseUrl} onChange={(e) => change("baseUrl", e.target.value)} required /></label><label>E-mail<input type="email" value={form.email} onChange={(e) => change("email", e.target.value)} required /></label><label>Projeto padrão<input value={form.defaultProjectKey} onChange={(e) => change("defaultProjectKey", e.target.value.toUpperCase())} placeholder="SCRUM" /><small>Opcional; apenas uma sugestão inicial.</small></label><label>Tipo de subtask<input value={form.subtaskIssueType} onChange={(e) => change("subtaskIssueType", e.target.value)} placeholder="Subtask" /></label><label className="wide">{profile ? "Novo API token (opcional)" : "API token"}<input type="password" autoComplete="new-password" value={form.apiToken} onChange={(e) => change("apiToken", e.target.value)} required={!profile} /><small>{profile ? "Preencha somente para rotacionar a credencial." : "O token será validado, cifrado e removido do formulário."}</small></label><fieldset className="advanced wide"><legend>Aliases de status opcionais</legend><label>Status em andamento<input value={form.statusInProgress} onChange={(e) => change("statusInProgress", e.target.value)} placeholder="Em andamento" /></label><label>Status em revisão<input value={form.statusCodeReview} onChange={(e) => change("statusCodeReview", e.target.value)} placeholder="Em análise" /></label><label>Status concluído<input value={form.statusDone} onChange={(e) => change("statusDone", e.target.value)} placeholder="Concluído" /></label></fieldset><fieldset className="custom-fields wide"><legend>Campos personalizados opcionais</legend><p>Associe nomes usados pelo agente aos IDs existentes neste Jira.</p>{customFields.map((item, index) => <div className="custom-field-row" key={index}><input aria-label="Nome lógico" value={item.logicalName} onChange={(e) => updateCustomField(index, "logicalName", e.target.value)} placeholder="acceptanceCriteria" required /><span>→</span><input aria-label="ID do campo Jira" value={item.jiraFieldId} onChange={(e) => updateCustomField(index, "jiraFieldId", e.target.value)} placeholder="customfield_10000" required /><button type="button" className="danger-link" onClick={() => removeCustomField(index)}>Remover</button></div>)}<button type="button" onClick={() => setCustomFields((items) => [...items, { logicalName: "", jiraFieldId: "" }])}>Adicionar campo</button></fieldset></div>{error && <div className="alert error">{error}</div>}<div className="actions end"><button type="button" onClick={onClose}>Cancelar</button><button className="primary" disabled={saving}>{saving ? "Validando..." : "Validar e salvar"}</button></div></form></div>;
}

function WorkspacesPage() {
  const [items, setItems] = useState<WorkspaceBinding[]>([]); const [profiles, setProfiles] = useState<JiraProfile[]>([]); const [error, setError] = useState("");
  const [form, setForm] = useState({ workspacePath: "", jiraProfileId: "", jiraProjectKey: "" });
  const load = () => Promise.all([api<WorkspaceBinding[]>("/workspace-bindings"), api<JiraProfile[]>("/jira-profiles")]).then(([a, b]) => { setItems(a); setProfiles(b); }).catch((e) => setError(message(e)));
  useEffect(() => { void load(); }, []);
  async function submit(e: FormEvent) { e.preventDefault(); setError(""); try { await api("/workspace-bindings", { method: "POST", body: JSON.stringify(form) }); setForm({ workspacePath: "", jiraProfileId: "", jiraProjectKey: "" }); void load(); } catch (reason) { setError(message(reason)); } }
  async function remove(id: string) { if (!confirm("Remover este vínculo?")) return; await api(`/workspace-bindings/${id}`, { method: "DELETE" }); void load(); }
  return <><Header eyebrow="Roteamento" title="Workspaces" subtitle="Defina qual Jira e projeto cada código-fonte utiliza." /><form className="panel inline-form" onSubmit={submit}><label>Caminho do workspace<input value={form.workspacePath} onChange={(e) => setForm({ ...form, workspacePath: e.target.value })} placeholder="/projetos/classmap" required /></label><label>Jira<select value={form.jiraProfileId} onChange={(e) => setForm({ ...form, jiraProfileId: e.target.value })} required><option value="">Selecione</option>{profiles.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Projeto<input value={form.jiraProjectKey} onChange={(e) => setForm({ ...form, jiraProjectKey: e.target.value.toUpperCase() })} required /></label><button className="primary">Vincular</button></form>{error && <div className="alert error">{error}</div>}<div className="panel table-wrap"><table><thead><tr><th>Workspace</th><th>Jira</th><th>Projeto</th><th>Último uso</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.workspaceId}><td><strong>{item.workspaceName}</strong><small>{item.canonicalPath}</small></td><td>{profiles.find((p) => p.id === item.jiraProfileId)?.name ?? item.jiraProfileId}</td><td><span className="badge">{item.jiraProjectKey}</span></td><td>{date(item.lastUsedAt)}</td><td><button className="danger-link" onClick={() => void remove(item.workspaceId)}>Remover</button></td></tr>)}</tbody></table>{!items.length && <Empty text="Nenhum workspace vinculado." />}</div></>;
}

function IssuesPage() {
  const [workspacePath, setWorkspacePath] = useState(""); const [issueKey, setIssueKey] = useState(""); const [issue, setIssue] = useState<any>(); const [error, setError] = useState("");
  const [task, setTask] = useState({ summary: "", description: "" });
  const [subtask, setSubtask] = useState({ summary: "", description: "" });
  const [transitions, setTransitions] = useState<Array<{ id: string; name: string; to: { name: string } }>>([]);
  const [attachments, setAttachments] = useState<Array<{ id: string; filename: string; mimeType: string; size: number }>>([]);
  const [attachment, setAttachment] = useState<{ filename: string; mimeType: string; text?: string; base64?: string }>();
  async function loadIssue(key = issueKey) { const encodedWorkspace = encodeURIComponent(workspacePath); const [found, available, files] = await Promise.all([api<any>(`/issues/${key}?workspacePath=${encodedWorkspace}`), api<any[]>(`/issues/${key}/transitions?workspacePath=${encodedWorkspace}`), api<any[]>(`/issues/${key}/attachments?workspacePath=${encodedWorkspace}`)]); setIssue(found); setTransitions(available); setAttachments(files); }
  async function search(e: FormEvent) { e.preventDefault(); setError(""); try { await loadIssue(); } catch (reason) { setError(message(reason)); } }
  async function create(e: FormEvent) { e.preventDefault(); setError(""); try { const result = await api<any>("/issues/tasks", { method: "POST", body: JSON.stringify({ workspacePath, ...task }) }); setIssueKey(result.key); setTask({ summary: "", description: "" }); } catch (reason) { setError(message(reason)); } }
  async function edit(e: FormEvent) { e.preventDefault(); setError(""); try { await api(`/issues/${issueKey}`, { method: "PATCH", body: JSON.stringify({ workspacePath, summary: issue.fields.summary, description: plainAdf(issue.fields.description) }) }); await loadIssue(); } catch (reason) { setError(message(reason)); } }
  async function createSubtask(e: FormEvent) { e.preventDefault(); setError(""); try { await api("/issues/subtasks", { method: "POST", body: JSON.stringify({ workspacePath, parentIssueKey: issueKey, ...subtask }) }); setSubtask({ summary: "", description: "" }); await loadIssue(); } catch (reason) { setError(message(reason)); } }
  async function transition(targetStatus: string) { if (!confirm(`Executar transição para ${targetStatus}?`)) return; try { await api(`/issues/${issueKey}/transitions`, { method: "POST", body: JSON.stringify({ workspacePath, targetStatus }) }); await loadIssue(); } catch (reason) { setError(message(reason)); } }
  async function readAttachment(id: string) { try { setAttachment(await api(`/issues/${issueKey}/attachments/${id}?workspacePath=${encodeURIComponent(workspacePath)}`)); } catch (reason) { setError(message(reason)); } }
  return <><Header eyebrow="Operação" title="Issues" subtitle="Tasks, subtasks, workflow e anexos pelo vínculo do workspace." />{error && <div className="alert error">{error}</div>}<section className="panel issue-search"><form onSubmit={search} className="inline-form compact"><label>Workspace<input value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} required /></label><label>Issue key<input value={issueKey} onChange={(e) => setIssueKey(e.target.value.toUpperCase())} placeholder="SCRUM-123" required /></label><button>Consultar</button></form></section><div className="split issue-columns"><section className="panel"><h3>Nova task</h3><form onSubmit={create} className="stack"><label>Resumo<input value={task.summary} onChange={(e) => setTask({ ...task, summary: e.target.value })} required /></label><label>Descrição<textarea value={task.description} onChange={(e) => setTask({ ...task, description: e.target.value })} /></label><button className="primary">Criar task</button></form></section>{issue && <section className="panel"><div className="issue-result"><span className="badge">{issue.fields?.status?.name}</span><h2>{issue.key}</h2><form className="stack" onSubmit={edit}><label>Resumo<input value={issue.fields?.summary ?? ""} onChange={(e) => setIssue({ ...issue, fields: { ...issue.fields, summary: e.target.value } })} /></label><label>Descrição<textarea value={plainAdf(issue.fields?.description)} onChange={(e) => setIssue({ ...issue, fields: { ...issue.fields, description: textAdf(e.target.value) } })} /></label><button>Salvar alterações</button></form><h4>Transições</h4><div className="actions wrap">{transitions.map((item) => <button key={item.id} onClick={() => void transition(item.to.name)}>{item.name} → {item.to.name}</button>)}</div><h4>Nova subtask</h4><form className="stack" onSubmit={createSubtask}><label>Resumo<input value={subtask.summary} onChange={(e) => setSubtask({ ...subtask, summary: e.target.value })} required /></label><label>Descrição<textarea value={subtask.description} onChange={(e) => setSubtask({ ...subtask, description: e.target.value })} /></label><button>Criar subtask</button></form><h4>Anexos</h4><div className="attachment-list">{attachments.map((file) => <button key={file.id} onClick={() => void readAttachment(file.id)}><strong>{file.filename}</strong><small>{file.mimeType} · {formatBytes(file.size)}</small></button>)}{!attachments.length && <p>Sem anexos.</p>}</div>{attachment && <AttachmentPreview attachment={attachment} />}</div></section>}</div></>;
}

function LogsPage() {
  const [logs, setLogs] = useState<CallLog[]>([]); const [outcome, setOutcome] = useState("");
  const load = () => api<CallLog[]>(`/mcp-call-logs${outcome ? `?outcome=${outcome}` : ""}`).then(setLogs);
  useEffect(() => { void load(); const source = new EventSource("/api/admin/mcp-call-logs/stream"); source.addEventListener("call-log", (event) => { const log = JSON.parse((event as MessageEvent).data) as CallLog; setLogs((current) => [log, ...current.filter((item) => item.id !== log.id)].slice(0, 200)); }); return () => source.close(); }, [outcome]);
  return <><Header eyebrow="Observabilidade" title="Logs MCP" subtitle="Chamadas sanitizadas recebidas pelo endpoint Streamable HTTP." action={<select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">Todos os resultados</option><option value="success">Sucesso</option><option value="error">Erro</option><option value="running">Em execução</option></select>} /><div className="stats"><Stat label="Chamadas exibidas" value={logs.length} /><Stat label="Erros" value={logs.filter((l) => l.outcome === "error").length} /><Stat label="Latência média" value={`${average(logs.map((l) => l.durationMs ?? 0))} ms`} /></div><div className="panel table-wrap"><table><thead><tr><th>Horário</th><th>Método</th><th>Tool / recurso</th><th>Duração</th><th>Resultado</th><th>Request ID</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{date(log.receivedAt)}</td><td><code>{log.protocolMethod}</code></td><td><strong>{log.targetName ?? "—"}</strong></td><td>{log.durationMs === undefined ? "—" : `${log.durationMs} ms`}</td><td><span className={`badge ${log.outcome}`}>{log.outcome}</span></td><td><button className="request-id" onClick={() => navigator.clipboard.writeText(log.requestId)}>{log.requestId.slice(0, 8)}…</button></td></tr>)}</tbody></table>{!logs.length && <Empty text="Nenhuma chamada MCP registrada." />}</div></>;
}

function Nav({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) { return <button className={active ? "active" : ""} onClick={onClick}>{label}</button>; }
function Header({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: React.ReactNode }) { return <header><div><small>{eyebrow}</small><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Stat({ label, value }: { label: string; value: string | number }) { return <div className="panel stat"><small>{label}</small><strong>{value}</strong></div>; }
function AttachmentPreview({ attachment }: { attachment: { filename: string; mimeType: string; text?: string; base64?: string } }) {
  if (attachment.text !== undefined) return <pre className="attachment-preview">{attachment.text}</pre>;
  const source = `data:${attachment.mimeType};base64,${attachment.base64}`;
  if (attachment.mimeType.startsWith("image/")) return <div className="attachment-preview"><img src={source} alt={attachment.filename} /></div>;
  if (attachment.mimeType === "application/pdf") return <iframe className="attachment-preview pdf" sandbox="" title={attachment.filename} src={source} />;
  return <a className="download" download={attachment.filename} href={source}>Baixar {attachment.filename}</a>;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Erro inesperado"; }
function slug(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function date(value: string) { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
function average(values: number[]) { return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0; }
function plainAdf(value: any) { return value?.content?.flatMap((p: any) => p.content ?? []).map((n: any) => n.text ?? "").join(" "); }
function textAdf(value: string) { return { type: "doc", version: 1, content: [{ type: "paragraph", content: value ? [{ type: "text", text: value }] : [] }] }; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1_048_576 ? `${Math.round(value / 1024)} KB` : `${(value / 1_048_576).toFixed(1)} MB`; }
function commandLabel(value: SddCommandKind) { return value === "sdd-task" ? "/sdd-task" : value === "sdd-plan" ? "/sdd-plan" : "/sdd-build"; }
