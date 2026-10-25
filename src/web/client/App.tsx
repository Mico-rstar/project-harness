import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import { createWebStore, type WebClientState, type WebStore } from "./store";
import type {
  WebAgent,
  WebBlock,
  WebCooperationMessage,
  WebEntry,
  WebOwner,
} from "../contracts";
import {
  Avatar,
  EntryBlocks,
  formatTime,
  Icon,
  Markdown,
  RequestCard,
  ToolCard,
  WorkGroup,
} from "./components";
import { agentDepth, groupMembers, groupTranscript } from "./groups";
import "./styles.css";

type View =
  | { kind: "main" }
  | { kind: "cooperation" }
  | { kind: "owner"; owner: WebOwner; tab: "session" | "cooperation" }
  | { kind: "agent"; agent: WebAgent; returnSessionId: string };

interface SavedLayout {
  leftOpen: boolean;
  rightOpen: boolean;
  rightMax: boolean;
  rightWidth: number;
}

const LAYOUT_KEY = "project-harness:web-layout";

function readLayout(): SavedLayout {
  const fallback = { leftOpen: true, rightOpen: true, rightMax: false, rightWidth: 302 };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const saved = value as Partial<SavedLayout>;
    return {
      leftOpen: typeof saved.leftOpen === "boolean" ? saved.leftOpen : fallback.leftOpen,
      rightOpen: typeof saved.rightOpen === "boolean" ? saved.rightOpen : fallback.rightOpen,
      rightMax: typeof saved.rightMax === "boolean" ? saved.rightMax : fallback.rightMax,
      rightWidth:
        typeof saved.rightWidth === "number"
          ? Math.min(520, Math.max(260, saved.rightWidth))
          : fallback.rightWidth,
    };
  } catch {
    return fallback;
  }
}

function useStore(store: WebStore): WebClientState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function sessionLabel(state: WebClientState, id: string): string {
  if (id === state.snapshot?.mainSessionId) return "Main";
  const session = state.snapshot?.sessions.find((item) => item.sessionId === id);
  const agent = state.snapshot?.agents.find(
    (item) => item.id === id || item.id === session?.ownerId,
  );
  const owner = state.snapshot?.owners.find(
    (item) => item.id === id || item.id === session?.ownerId,
  );
  return agent?.displayName ?? owner?.title ?? "会话";
}

function ownerForAgent(
  agent: WebAgent,
  agents: WebAgent[],
  owners: WebOwner[],
): WebOwner | undefined {
  let current: WebAgent | undefined = agent;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const owner = owners.find((item) => item.id === current?.id);
    if (owner) return owner;
    current = agents.find((item) => item.id === current?.parentId);
  }
  return undefined;
}

export default function App({ store: providedStore }: { store?: WebStore }) {
  const store = useMemo(() => providedStore ?? createWebStore(), [providedStore]);
  const state = useStore(store);
  const [view, setView] = useState<View>({ kind: "main" });
  const [ownerSearch, setOwnerSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [layout, setLayout] = useState(readLayout);
  const { leftOpen, rightOpen, rightMax, rightWidth } = layout;
  const [mobileDrawer, setMobileDrawer] = useState(false);
  const [contextDrawer, setContextDrawer] = useState(false);
  const [freshCount, setFreshCount] = useState(0);
  const freshCountRef = useRef(0);
  // Dispatch setFreshCount(0) only when the count would actually change: under
  // sustained streaming there is almost always pending work on this fiber, so
  // a redundant same-value dispatch never bails out and pushes React over its
  // nested-update limit ("Maximum update depth exceeded").
  const clearFresh = () => {
    if (freshCountRef.current !== 0) {
      freshCountRef.current = 0;
      setFreshCount(0);
    }
  };
  const addFresh = (added: number) => {
    freshCountRef.current += added;
    setFreshCount((value) => value + added);
  };
  const [cooperationOwner, setCooperationOwner] = useState<string | undefined>();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<HTMLElement>(null);
  const sendLock = useRef(false);
  const nearBottom = useRef(true);
  const previousEntryCount = useRef(0);
  const mainSessionId = state.snapshot?.mainSessionId ?? "main";
  const activeSessionId = state.activeSessionId ?? mainSessionId;
  const canonicalSessionId = state.histories[activeSessionId]?.data?.sessionId ?? activeSessionId;
  const requestedSession = state.snapshot?.sessions.find(
    (item) => item.sessionId === canonicalSessionId,
  );
  const activeSession =
    requestedSession ?? state.snapshot?.sessions.find((item) => item.ownerId === activeSessionId);
  const mainSession = state.snapshot?.sessions.find((item) => item.sessionId === mainSessionId);
  const mainRunning = Boolean(mainSession?.isStreaming);
  const isMain = activeSessionId === mainSessionId || view.kind === "cooperation";
  const selectedOwner = view.kind === "owner" ? view.owner : undefined;
  const owners = state.snapshot?.owners ?? [];
  const agents = state.snapshot?.agents ?? [];
  const focusedOwnerId =
    selectedOwner?.id ??
    (view.kind === "agent" ? ownerForAgent(view.agent, agents, owners)?.id : undefined);
  const ownerGroups = useMemo(() => groupMembers(agents, owners), [agents, owners]);
  const focusedGroup = focusedOwnerId
    ? ownerGroups.find((group) => group.owner?.id === focusedOwnerId)
    : undefined;
  const mainAgent = agents.find(
    (agent) =>
      agent.kind === "main" ||
      (state.snapshot?.mainSessionId ? agent.id === state.snapshot.mainSessionId : false),
  );
  const activeHistoryState = state.histories[activeSessionId];
  const history = activeHistoryState?.data;
  const entries = history?.entries ?? [];
  const stream = history?.stream ?? activeSession?.stream ?? null;
  const liveTools = history?.activeTools ?? activeSession?.activeTools ?? [];
  const cooperation = state.cooperation?.items ?? [];
  const requests = state.pendingUIRequests;
  const receipts = Object.values(state.receipts);
  const latestReceipt = receipts.sort((first, second) => second.updatedAt - first.updatedAt)[0];
  const uncertainInputId = state.uncertainInputId;
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = state.connection !== "connected" || !state.snapshot;
  const filteredOwners = owners.filter((owner) =>
    `${owner.title} ${owner.id} ${owner.branch}`.toLowerCase().includes(ownerSearch.toLowerCase()),
  );

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Layout remains usable when browser storage is unavailable.
    }
  }, [layout]);

  useEffect(() => {
    if (view.kind === "main" || view.kind === "cooperation") store.setActiveSession(mainSessionId);
    else if (view.kind === "owner") store.setActiveSession(view.owner.id);
    else store.setActiveSession(view.agent.id);
  }, [view, mainSessionId, store]);

  useEffect(() => {
    void store.loadCooperation(cooperationOwner);
  }, [cooperationOwner, store]);

  // Switching views always lands on the latest content: reset stickiness and
  // jump to the bottom; late-arriving history re-pins via the effect below.
  useEffect(() => {
    nearBottom.current = true;
    clearFresh();
    for (const element of [transcriptRef.current, feedRef.current]) {
      element?.scrollTo({ top: element.scrollHeight });
    }
  }, [activeSessionId, view]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const count = entries.length + (stream ? 1 : 0);
    if (nearBottom.current) {
      element.scrollTop = element.scrollHeight;
      clearFresh();
    } else if (count > previousEntryCount.current) {
      addFresh(count - previousEntryCount.current);
    }
    previousEntryCount.current = count;
  }, [entries.length, stream?.id, stream?.blocks, activeSessionId]);

  const changeView = (next: View) => {
    setView(next);
    setMobileDrawer(false);
    clearFresh();
  };

  const returnFromAgent = (agentView: Extract<View, { kind: "agent" }>) => {
    if (agentView.returnSessionId === mainSessionId) {
      changeView({ kind: "main" });
      return;
    }
    const owner = owners.find(
      (item) =>
        item.id === agentView.returnSessionId ||
        state.snapshot?.sessions.some(
          (session) =>
            session.sessionId === agentView.returnSessionId && session.ownerId === item.id,
        ),
    );
    if (owner) changeView({ kind: "owner", owner, tab: "session" });
    else {
      const parent = agents.find((item) => item.id === agentView.returnSessionId);
      if (parent) changeView({ kind: "agent", agent: parent, returnSessionId: mainSessionId });
      else changeView({ kind: "main" });
    }
  };

  const scrollToLatest = () => {
    const element = transcriptRef.current;
    if (element) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      nearBottom.current = true;
      clearFresh();
    }
  };

  const send = async () => {
    if (sendLock.current) return;
    if (state.draft.trim() && !busy) {
      sendLock.current = true;
      setSubmitting(true);
      setSendError(null);
      try {
        if (uncertainInputId) await store.retryInput(uncertainInputId);
        else await store.submitInput();
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "发送失败，可重试");
      } finally {
        sendLock.current = false;
        setSubmitting(false);
      }
    } else if (!state.draft.trim() && mainRunning && !busy) {
      sendLock.current = true;
      setSubmitting(true);
      try {
        await store.abortMain();
      } catch {
        /* snapshot health reports the failure */
      } finally {
        sendLock.current = false;
        setSubmitting(false);
      }
    }
  };

  const insertOwnerContext = () => {
    if (!selectedOwner) return;
    const token = `@${selectedOwner.id} `;
    store.setDraft(
      state.draft ? `${state.draft}${state.draft.endsWith(" ") ? "" : " "}${token}` : token,
    );
  };

  const updateLayout = (patch: Partial<SavedLayout>) =>
    setLayout((current) => ({ ...current, ...patch }));

  const toggleRight = () => {
    if (rightMax) {
      updateLayout({ rightMax: false, rightOpen: true });
    } else updateLayout({ rightOpen: !rightOpen });
  };

  const resizeRight = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) =>
      updateLayout({
        rightWidth: Math.min(520, Math.max(260, window.innerWidth - moveEvent.clientX)),
      });
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const title =
    view.kind === "main"
      ? "Main"
      : view.kind === "cooperation"
        ? "全局协作"
        : view.kind === "owner"
          ? view.owner.title
          : view.agent.displayName;
  const transcriptGroups = useMemo(
    () =>
      groupTranscript(
        [...entries, ...(stream && !entries.some((entry) => entry.id === stream.id) ? [stream] : [])],
        { liveTools, streamId: stream?.id },
      ),
    [entries, stream, liveTools],
  );

  return (
    <div
      className={`app-shell${rightOpen ? "" : " context-hidden"}${rightMax ? " context-max" : ""}${!leftOpen ? " nav-hidden" : ""}`}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <button
            className="icon-button mobile-menu"
            aria-label="打开导航"
            onClick={() => {
              setContextDrawer(false);
              setMobileDrawer((value) => !value);
            }}
          >
            <Icon name="menu" />
          </button>
          <div className="brand-mark">
            <Icon name="spark" size={17} />
          </div>
          <div className="brand-text">
            <strong>{state.snapshot?.project.name ?? "Project Harness"}</strong>
            <span>{state.snapshot?.project.repoRoot ?? "正在连接项目…"}</span>
          </div>
        </div>
        <div className={`connection-pill connection-${state.connection}`}>
          <span className="status-dot" />
          {connectionText(state)}
        </div>
        <div className="topbar-actions">
          {requests.length > 0 && (
            <button
              className="pending-pill"
              onClick={() => {
                if (window.matchMedia("(max-width: 790px)").matches) {
                  setMobileDrawer(false);
                  setContextDrawer(true);
                } else {
                  updateLayout({ rightOpen: true, rightMax: false });
                }
                requestAnimationFrame(() =>
                  pendingRef.current?.scrollIntoView({ behavior: "smooth" }),
                );
              }}
            >
              <span className="pending-dot" />
              {requests.length} 项待响应
            </button>
          )}
          <button
            className={`icon-button${rightOpen || contextDrawer ? " active" : ""}`}
            aria-label={rightOpen || contextDrawer ? "收起上下文" : "打开上下文"}
            onClick={() => {
              if (window.matchMedia("(max-width: 790px)").matches) {
                setMobileDrawer(false);
                setContextDrawer((value) => !value);
              } else toggleRight();
            }}
          >
            <Icon name="panel" />
          </button>
        </div>
      </header>

      {(state.error || state.notification || state.snapshot?.health.degraded) && (
        <div
          className={`global-alert${state.notification?.level === "error" || state.snapshot?.health.degraded ? " alert-warning" : ""}`}
        >
          <Icon name="alert" size={15} />
          {state.error ?? state.notification?.message ?? state.snapshot?.health.issues.join("；")}
          {state.connection === "error" && (
            <button onClick={() => store.start()} aria-label="重新连接">
              <Icon name="reload" size={15} />
            </button>
          )}
        </div>
      )}

      <div className="workspace">
        {(mobileDrawer || contextDrawer) && (
          <button
            className="drawer-scrim"
            aria-label="关闭侧栏"
            onClick={() => {
              setMobileDrawer(false);
              setContextDrawer(false);
            }}
          />
        )}
        <aside className={`navigation${mobileDrawer ? " drawer-open" : ""}`}>
          <div className="nav-section">
            <div className="nav-label">工作区</div>
            <button
              className={`nav-item${view.kind === "main" ? " selected" : ""}`}
              onClick={() => changeView({ kind: "main" })}
            >
              <span className="nav-icon main-icon">
                <Icon name="spark" size={17} />
              </span>
              <span className="nav-copy">
                <strong>Main</strong>
                <small>项目主会话</small>
              </span>
              {state.snapshot?.sessions.find((item) => item.sessionId === mainSessionId)
                ?.isStreaming && <span className="live-dot" />}
            </button>
            <button
              className={`nav-item${view.kind === "cooperation" ? " selected" : ""}`}
              onClick={() => {
                setCooperationOwner(undefined);
                changeView({ kind: "cooperation" });
              }}
            >
              <span className="nav-icon">
                <Icon name="users" size={17} />
              </span>
              <span className="nav-copy">
                <strong>全局协作</strong>
                <small>owner 间消息</small>
              </span>
              {cooperation.length > 0 && <span className="nav-count">{cooperation.length}</span>}
            </button>
          </div>
          <div className="nav-divider" />
          <div className="owner-section">
            <div className="section-heading">
              <span className="nav-label">OWNER 会话</span>
              <span className="count-label">{owners.length}</span>
            </div>
            <label className="search-box">
              <Icon name="search" size={15} />
              <input
                value={ownerSearch}
                onChange={(event) => setOwnerSearch(event.target.value)}
                placeholder="搜索 owner…"
              />
              <kbd>⌘ K</kbd>
            </label>
            <div className="owner-list">
              {filteredOwners.map((owner) => {
                const session = state.snapshot?.sessions.find(
                  (item) => item.ownerId === owner.id || item.sessionId === owner.id,
                );
                const active = view.kind === "owner" && view.owner.id === owner.id;
                return (
                  <button
                    className={`owner-item${active ? " selected" : ""}`}
                    key={owner.id}
                    onClick={() => changeView({ kind: "owner", owner, tab: "session" })}
                  >
                    <Avatar label={owner.title || owner.id} tone="owner" />
                    <span className="owner-copy">
                      <strong>{owner.title}</strong>
                      <small>
                        {session?.isStreaming
                          ? session.stream?.blocks
                              .map((block) => (block.type === "tool" ? "" : block.text))
                              .join("")
                              .slice(0, 30) || "正在运行…"
                          : owner.branch || owner.id}
                      </small>
                    </span>
                    {session?.isStreaming && <span className="live-dot" />}
                  </button>
                );
              })}
              {filteredOwners.length === 0 && (
                <div className="empty-owners">
                  {owners.length ? (
                    "没有匹配的 owner"
                  ) : (
                    <>
                      <Icon name="branch" size={17} />
                      <span>还没有 owner 会话</span>
                      <small>由 Main 在协作过程中创建</small>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="nav-footer">
            <span className="runtime-indicator">
              <span className="status-dot" />
              {state.snapshot?.closing ? "正在关闭" : "本地运行时"}
            </span>
            <span className="version-tag">HARNESS</span>
          </div>
        </aside>

        <main className="conversation">
          <div className="conversation-header">
            <div className="conversation-heading">
              {!leftOpen && (
                <button
                  className="icon-button header-icon"
                  aria-label="展开导航"
                  onClick={() => updateLayout({ leftOpen: true })}
                >
                  <Icon name="menu" />
                </button>
              )}
              {view.kind === "owner" ? (
                <Avatar label={view.owner.title} tone="owner" />
              ) : view.kind === "agent" ? (
                <Avatar label={view.agent.displayName} />
              ) : (
                <div
                  className={`header-avatar ${view.kind === "cooperation" ? "collab-avatar" : ""}`}
                >
                  <Icon name={view.kind === "cooperation" ? "users" : "spark"} size={16} />
                </div>
              )}
              <div>
                <h1>{title}</h1>
                <div className="heading-subtitle">
                  {view.kind === "main" ? (
                    "与项目 Main 对话"
                  ) : view.kind === "owner" ? (
                    <>
                      <Icon name="branch" size={12} />
                      {view.owner.branch || "owner worktree"}
                    </>
                  ) : view.kind === "agent" ? (
                    "子代理只读会话"
                  ) : (
                    "项目中的协作消息"
                  )}
                </div>
              </div>
            </div>
            <div className="conversation-actions">
              {view.kind === "owner" && (
                <button
                  className="owner-context-chip"
                  onClick={insertOwnerContext}
                  title="将 owner 上下文插入消息草稿"
                >
                  <Icon name="plus" size={13} />@{view.owner.id}
                </button>
              )}
              {view.kind === "agent" && (
                <button className="button-subtle" onClick={() => returnFromAgent(view)}>
                  返回所属会话
                </button>
              )}
              {(view.kind === "main" || view.kind === "owner") && (
                <div className="menu-anchor">
                  <button
                    className="icon-button"
                    aria-label="会话菜单"
                    onClick={() => setMenuOpen((value) => !value)}
                  >
                    <Icon name="more" />
                  </button>
                  {menuOpen && (
                    <>
                      <button
                        className="menu-dismiss"
                        aria-label="关闭菜单"
                        onClick={() => setMenuOpen(false)}
                      />
                      <div className="dropdown-menu">
                        <div className="menu-title">输入模式</div>
                        <button
                          onClick={() => {
                            store.setInputBehavior("followUp");
                            setMenuOpen(false);
                          }}
                        >
                          <span>继续对话</span>
                          <span>{state.inputBehavior === "followUp" ? "✓" : ""}</span>
                        </button>
                        <button
                          onClick={() => {
                            store.setInputBehavior("steer");
                            setMenuOpen(false);
                          }}
                        >
                          <span>引导当前回复</span>
                          <span>{state.inputBehavior === "steer" ? "✓" : ""}</span>
                        </button>
                        {mainRunning && (
                          <>
                            <div className="menu-separator" />
                            <button
                              className="menu-danger"
                              onClick={() => {
                                void store.abortMain();
                                setMenuOpen(false);
                              }}
                            >
                              中止 Main 当前轮次
                            </button>
                          </>
                        )}
                        <div className="menu-separator" />
                        <button
                          onClick={() => {
                            updateLayout({ leftOpen: false });
                            setMenuOpen(false);
                          }}
                        >
                          收起导航
                        </button>
                        <button
                          onClick={() => {
                            updateLayout({ leftOpen: false, rightOpen: false, rightMax: false });
                            setMenuOpen(false);
                          }}
                        >
                          最大化会话
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {view.kind === "owner" && (
            <div className="session-tabs">
              <button
                className={view.tab === "session" ? "tab-active" : ""}
                onClick={() => changeView({ ...view, tab: "session" })}
              >
                <Icon name="message" size={14} />
                Owner 会话
              </button>
              <button
                className={view.tab === "cooperation" ? "tab-active" : ""}
                onClick={() => {
                  setCooperationOwner(view.owner.id);
                  changeView({ ...view, tab: "cooperation" });
                }}
              >
                <Icon name="users" size={14} />
                相关协作
              </button>
            </div>
          )}
          {view.kind === "agent" && (
            <div className="readonly-banner">
              <Icon name="alert" size={14} />
              这是子代理的只读会话，消息仍发送给 Main。
            </div>
          )}

          {view.kind === "cooperation" || (view.kind === "owner" && view.tab === "cooperation") ? (
            <CooperationFeed
              messages={cooperation}
              state={state}
              scrollRef={feedRef}
              onOpenOwner={(owner) => changeView({ kind: "owner", owner, tab: "session" })}
              onLoadMore={() =>
                void store.loadCooperation(
                  cooperationOwner,
                  state.cooperation?.nextBefore ?? undefined,
                )
              }
              loading={state.cooperation === null}
              coverage={state.cooperation?.coverage}
            />
          ) : (
            <div
              className="transcript"
              ref={transcriptRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                nearBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 120;
                if (nearBottom.current) clearFresh();
                if (
                  element.scrollTop < 80 &&
                  history?.nextBeforeEntryId &&
                  !activeHistoryState?.loading
                ) {
                  const beforeHeight = element.scrollHeight;
                  void store.loadHistory(activeSessionId, history.nextBeforeEntryId).then(() =>
                    requestAnimationFrame(() => {
                      element.scrollTop += element.scrollHeight - beforeHeight;
                    }),
                  );
                }
              }}
            >
              {activeHistoryState?.loading && entries.length === 0 && (
                <div className="loading-history">
                  <span className="spinner" />
                  载入会话记录…
                </div>
              )}
              {activeHistoryState?.error && (
                <div className="history-error">
                  <Icon name="alert" size={16} />
                  <span>{activeHistoryState.error}</span>
                  <button onClick={() => void store.loadHistory(activeSessionId)}>重试</button>
                </div>
              )}
              {!activeHistoryState?.loading &&
                !activeHistoryState?.error &&
                entries.length === 0 &&
                !stream && (
                  <div className="empty-transcript">
                    <div className="empty-orb">
                      <Icon name={view.kind === "agent" ? "users" : "spark"} size={24} />
                    </div>
                    <h2>
                      {view.kind === "agent"
                        ? "暂无可读取的子代理记录"
                        : view.kind === "owner"
                          ? "Owner 会话已就绪"
                          : "从这里开始"}
                    </h2>
                    <p>
                      {view.kind === "agent"
                        ? "当前子代理没有可用的会话历史。"
                        : view.kind === "owner"
                          ? "你可以在 Main 输入框中补充上下文并发送。"
                          : "描述你想推进的工作，Main 会帮助你拆解并协调 owner。"}
                    </p>
                    {view.kind === "main" && (
                      <div className="suggestion-list">
                        {[
                          "先了解这个项目的结构",
                          "帮我规划一个新功能",
                          "查看当前 owner 的运行进展",
                        ].map((suggestion) => (
                          <button key={suggestion} onClick={() => store.setDraft(suggestion)}>
                            {suggestion}
                            <Icon name="arrow" size={14} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              {history?.nextBeforeEntryId && (
                <button
                  className="load-older"
                  disabled={activeHistoryState?.loading}
                  onClick={() =>
                    void store.loadHistory(activeSessionId, history.nextBeforeEntryId ?? undefined)
                  }
                >
                  {activeHistoryState?.loading ? "正在加载…" : "加载更早的消息"}
                </button>
              )}
              {transcriptGroups.map((group) =>
                group.kind === "message" ? (
                  <Message
                    key={group.id}
                    entry={group.entry}
                    blocks={group.blocks}
                    sessionLabel={sessionLabel(state, activeSessionId)}
                    isStream={group.entry === stream}
                    onAgent={(agent) =>
                      changeView({ kind: "agent", agent, returnSessionId: activeSessionId })
                    }
                    agents={agents}
                    userLabel={view.kind === "owner" ? "任务输入" : "你"}
                  />
                ) : (
                  <WorkGroup
                    key={group.id}
                    group={group}
                    label={sessionLabel(state, activeSessionId)}
                  />
                ),
              )}
              {liveTools.length > 0 && (
                <div className="live-tools">
                  {liveTools.map((tool) => (
                    <ToolCard key={tool.toolCallId} tool={tool} compact />
                  ))}
                </div>
              )}
            </div>
          )}

          {freshCount > 0 && view.kind !== "cooperation" && (
            <button className="new-messages" onClick={scrollToLatest}>
              <Icon name="arrow" size={14} />
              {freshCount} 条新消息
            </button>
          )}

          <div className="composer-area">
            {latestReceipt && (
              <div className={`receipt-status receipt-${latestReceipt.state}`}>
                {latestReceipt.state === "received" && <span className="spinner small" />}
                <span>
                  {receiptText(latestReceipt.state)}
                  {latestReceipt.error ? ` · ${latestReceipt.error}` : ""}
                </span>
                <time>{formatTime(latestReceipt.updatedAt)}</time>
              </div>
            )}
            {sendError && (
              <div className="send-error" role="alert">
                <Icon name="alert" size={14} />
                {sendError}
                {uncertainInputId ? " · 点击发送按钮以相同请求 ID 重试" : ""}
              </div>
            )}
            {requests.length > 0 && (
              <div className="request-inline-summary">
                <Icon name="spark" size={14} />
                {requests.length} 项交互请求在右侧等待回应
              </div>
            )}
            <div className={`composer${busy ? " composer-busy" : ""}`}>
              {!isMain && (
                <div className="recipient-label">
                  <Icon name="send" size={12} />
                  发送给 Main <span>·</span>
                  {state.inputBehavior === "steer" ? "引导当前回复" : "继续对话"}
                </div>
              )}
              <textarea
                value={state.draft}
                disabled={submitting || Boolean(uncertainInputId)}
                onChange={(event) => {
                  setSendError(null);
                  store.setDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  busy
                    ? "正在同步运行时…"
                    : isMain
                      ? "发送消息给 Main…"
                      : "写给 Main，并附上可见的 owner 上下文…"
                }
                rows={2}
                aria-label="发送给 Main 的消息"
              />
              <div className="composer-bottom">
                <div className="composer-hint">
                  <kbd>↵</kbd> 发送 <span>·</span> <kbd>⇧ ↵</kbd> 换行
                </div>
                <div className="composer-controls">
                  {state.inputBehavior === "steer" && (
                    <span className="mode-indicator">引导模式</span>
                  )}
                  {(activeSession?.model ?? mainSession?.model) && (
                    <span className="composer-model">
                      {(activeSession?.model ?? mainSession?.model)?.name}
                    </span>
                  )}
                  <button
                    className={`send-button${!state.draft.trim() && mainRunning ? " stop-button" : ""}`}
                    onClick={() => void send()}
                    disabled={busy || submitting || (!state.draft.trim() && !mainRunning)}
                    aria-label={
                      uncertainInputId
                        ? "重试发送同一消息"
                        : state.draft.trim()
                          ? "发送消息给 Main"
                          : mainRunning
                            ? "中止 Main 当前轮次"
                            : "没有可发送的消息"
                    }
                    title={
                      uncertainInputId
                        ? "重试相同请求，不会创建新的输入"
                        : state.draft.trim()
                          ? "发送给 Main"
                          : mainRunning
                            ? "中止 Main 当前轮次"
                            : "输入消息"
                    }
                  >
                    <Icon
                      name={
                        uncertainInputId
                          ? "reload"
                          : state.draft.trim()
                            ? "arrow"
                            : mainRunning
                              ? "stop"
                              : "arrow"
                      }
                      size={17}
                    />
                  </button>
                </div>
              </div>
            </div>
            <div className="composer-disclaimer">
              {state.inputBehavior === "steer"
                ? "引导当前回复 · 消息仍发送给 Main"
                : "继续对话 · 消息仍发送给 Main"}
            </div>
          </div>
        </main>

        <button
          className="context-resizer"
          hidden={!rightOpen || rightMax}
          aria-label="调整上下文面板宽度"
          onPointerDown={resizeRight}
          style={{ right: `${rightWidth}px` }}
        />
        <aside
          className={`context-panel${!rightOpen && !contextDrawer ? " context-collapsed" : ""}${contextDrawer ? " context-drawer-open" : ""}${rightMax ? " context-expanded" : ""}`}
          style={{ "--context-width": `${rightWidth}px` } as CSSProperties}
        >
          <div className="context-heading">
            <div>
              <div className="eyebrow">运行上下文</div>
              <h2>{view.kind === "cooperation" ? "项目动态" : "当前会话"}</h2>
            </div>
            <div className="context-heading-actions">
              <button
                className="icon-button"
                aria-label={rightMax ? "恢复上下文宽度" : "最大化上下文"}
                onClick={() => updateLayout({ rightMax: !rightMax, rightOpen: true })}
              >
                <Icon name={rightMax ? "minimize" : "maximize"} size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="收起上下文"
                onClick={() => {
                  updateLayout({ rightOpen: false, rightMax: false });
                  setContextDrawer(false);
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <div className="context-scroll">
            <section className="context-section">
              <div className="context-section-heading">
                <span>活动</span>
                <span className="section-live">
                  <span className={mainRunning ? "live-dot" : "idle-dot"} />
                  {mainRunning ? "运行中" : "空闲"}
                </span>
              </div>
              {activeSession?.error && (
                <div className="context-error">
                  <Icon name="alert" size={14} />
                  {activeSession.error}
                </div>
              )}
              {mainRunning && (
                <div className="activity-card">
                  <span className="activity-icon spinning">
                    <Icon name="spark" size={15} />
                  </span>
                  <span>
                    <strong>Main 正在运行</strong>
                    <small>{mainSession?.isStreaming ? "正在生成回复" : "正在执行工具"}</small>
                  </span>
                  <span className="pulse-bars">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
              {liveTools.map((tool) => (
                <div className="activity-card" key={tool.toolCallId}>
                  <span className="activity-icon">
                    <Icon name="terminal" size={15} />
                  </span>
                  <span className="activity-copy">
                    <strong>{tool.toolName}</strong>
                    <small>{tool.result ? "正在返回结果" : "工具正在运行"}</small>
                  </span>
                  <span className="pulse-bars">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              ))}
              {!mainRunning && liveTools.length === 0 && (
                <div className="quiet-activity">
                  <span className="quiet-mark">
                    <Icon name="clock" size={15} />
                  </span>
                  <span>当前没有运行中的操作</span>
                </div>
              )}
              {(activeSession?.activeTools.length ?? 0) > 0 && liveTools.length === 0 && (
                <div className="activity-list">
                  {activeSession?.activeTools.map((tool) => (
                    <div className="activity-card" key={tool.toolCallId}>
                      <span className="activity-icon">
                        <Icon name="terminal" size={15} />
                      </span>
                      <span className="activity-copy">
                        <strong>{tool.toolName}</strong>
                        <small>运行中</small>
                      </span>
                      <span className="pulse-bars">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="context-section agents-section">
              <div className="context-section-heading">
                <span>协作成员</span>
                <span className="section-count">
                  {focusedOwnerId ? (focusedGroup?.children.length ?? 0) : owners.length}
                </span>
              </div>
              {focusedOwnerId && focusedGroup ? (
                <div className="agent-list">
                  {focusedGroup.owner && (
                    <OwnerRow
                      owner={focusedGroup.owner}
                      onOpen={(next) => changeView(next)}
                    />
                  )}
                  {focusedGroup.children.map((agent) => (
                    <SubagentRow
                      key={agent.id}
                      agent={agent}
                      depth={Math.max(
                        0,
                        agentDepth(agent, agents) -
                          (focusedGroup.root ? agentDepth(focusedGroup.root, agents) + 1 : 1),
                      )}
                      onOpen={(next) =>
                        changeView({ kind: "agent", agent: next, returnSessionId: activeSessionId })
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="agent-list">
                  {mainAgent && (
                    <button
                      className="agent-row"
                      onClick={() => changeView({ kind: "main" })}
                    >
                      <Avatar label={mainAgent.displayName} tone="agent" />
                      <span className="agent-copy">
                        <strong>{mainAgent.displayName}</strong>
                        <small>项目主会话</small>
                      </span>
                      <span
                        className={`agent-status${mainAgent.status.toLowerCase().includes("run") || mainAgent.status.toLowerCase().includes("active") ? " agent-running" : ""}`}
                      >
                        <i />
                        {mainAgent.status}
                      </span>
                    </button>
                  )}
                  {owners.map((owner) => (
                    <OwnerRow key={owner.id} owner={owner} onOpen={(next) => changeView(next)} />
                  ))}
                  {!mainAgent && owners.length === 0 && (
                    <div className="context-empty">协作成员会显示在这里</div>
                  )}
                </div>
              )}
            </section>

            <section className="context-section request-section" ref={pendingRef}>
              <div className="context-section-heading">
                <span>待响应请求</span>
                {requests.length > 0 && <span className="request-count">{requests.length}</span>}
              </div>
              {requests.length ? (
                <div className="request-list">
                  {requests.map((request) => (
                    <RequestCard
                      key={request.requestId}
                      request={request}
                      disabled={busy}
                      onRespond={(response) => store.respond(request.requestId, response)}
                    />
                  ))}
                </div>
              ) : (
                <div className="quiet-requests">
                  <span className="quiet-mark">
                    <Icon name="check" size={15} />
                  </span>
                  <span>没有待处理的请求</span>
                </div>
              )}
            </section>

            <section className="context-section recent-section">
              <div className="context-section-heading">
                <span>最近运行</span>
              </div>
              {entries
                .filter((entry) => entry.role === "assistant")
                .slice(-3)
                .reverse()
                .map((entry) => (
                  <div className="recent-item" key={entry.id}>
                    <span className="recent-line" />
                    <span>
                      <strong>
                        {entry.blocks
                          .map((block) => (block.type === "tool" ? "" : block.text))
                          .join("")
                          .slice(0, 56) || "工具调用"}
                      </strong>
                      <small>{formatTime(entry.timestamp)}</small>
                    </span>
                  </div>
                ))}
              {entries.filter((entry) => entry.role === "assistant").length === 0 && (
                <div className="context-empty">会话活动会出现在这里</div>
              )}
            </section>
          </div>
          <div className="context-footer">
            <button
              onClick={() => {
                updateLayout({ rightOpen: false, rightMax: false });
                setContextDrawer(false);
              }}
            >
              <Icon name="panel" size={15} />
              收起面板
            </button>
            <span>上下文</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OwnerRow({ owner, onOpen }: { owner: WebOwner; onOpen: (view: View) => void }) {
  return (
    <button className="agent-row" onClick={() => onOpen({ kind: "owner", owner, tab: "session" })}>
      <Avatar label={owner.title} tone="owner" />
      <span className="agent-copy">
        <strong>{owner.title}</strong>
        <small>{owner.branch || "Owner"}</small>
      </span>
      <Icon name="chevron" size={14} />
    </button>
  );
}

function SubagentRow({
  agent,
  depth,
  onOpen,
}: {
  agent: WebAgent;
  depth: number;
  onOpen: (agent: WebAgent) => void;
}) {
  return (
    <button
      className="agent-row agent-sub"
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      onClick={() => onOpen(agent)}
    >
      <Avatar label={agent.displayName} tone="agent" />
      <span className="agent-copy">
        <strong>{agent.displayName}</strong>
        <small>{agent.activity || agent.kind}</small>
      </span>
      <span
        className={`agent-status${agent.status.toLowerCase().includes("run") || agent.status.toLowerCase().includes("active") ? " agent-running" : ""}`}
      >
        <i />
        {agent.status}
      </span>
    </button>
  );
}

function Message({
  entry,
  blocks,
  sessionLabel: label,
  isStream,
  agents,
  onAgent,
  userLabel = "你",
}: {
  entry: WebEntry;
  blocks?: WebBlock[];
  sessionLabel: string;
  isStream: boolean;
  agents: WebAgent[];
  onAgent: (agent: WebAgent) => void;
  userLabel?: string;
}) {
  const isUser = entry.role === "user";
  const isTool = entry.role === "tool";
  if (entry.role === "system")
    return (
      <div className="system-message">
        <span />
        <EntryBlocks entry={entry} />
        <span />
      </div>
    );
  return (
    <article
      className={`message-row${isUser ? " message-user" : ""}${isTool ? " message-tool" : ""}${isStream ? " message-stream" : ""}`}
    >
      {!isUser && <Avatar label={isTool ? "T" : label} tone={isTool ? "owner" : "agent"} />}
      <div className="message-body">
        {!isUser && (
          <div className="message-meta">
            <strong>{isTool ? "工具" : label}</strong>
            {entry.timestamp && <time>{formatTime(entry.timestamp)}</time>}
            {!isTool && agents.length > 0 && (
              <div className="agent-mentions">
                {agents
                  .filter((agent) =>
                    entry.blocks.some(
                      (block) => block.type === "text" && block.text.includes(agent.id),
                    ),
                  )
                  .slice(0, 1)
                  .map((agent) => (
                    <button key={agent.id} onClick={() => onAgent(agent)}>
                      @{agent.displayName}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        <div
          className={`message-bubble${isUser ? " user-bubble" : ""}${isTool ? " tool-bubble" : ""}`}
        >
          <EntryBlocks entry={entry} blocks={blocks} />
        </div>
        {isUser && (
          <div className="message-meta user-meta">
            <time>{formatTime(entry.timestamp)}</time>
            <span>{userLabel}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function CooperationFeed({
  messages,
  state,
  scrollRef,
  onOpenOwner,
  onLoadMore,
  loading,
  coverage,
}: {
  messages: WebCooperationMessage[];
  state: WebClientState;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onOpenOwner: (owner: WebOwner) => void;
  onLoadMore: () => void;
  loading: boolean;
  coverage?: { recordedSince: number | null; hasGaps: boolean; warnings: string[] };
}) {
  const owners = state.snapshot?.owners ?? [];
  const label = (id: string) => owners.find((owner) => owner.id === id)?.title ?? id;
  const openOwner = (id: string) => {
    const owner = owners.find((item) => item.id === id);
    if (owner) onOpenOwner(owner);
  };
  return (
    <div className="cooperation-feed" ref={scrollRef}>
      <div className="feed-intro">
        <div className="feed-icon">
          <Icon name="users" size={19} />
        </div>
        <div>
          <h2>项目协作</h2>
          <p>owner 与 Main 之间的消息记录</p>
        </div>
      </div>
      {coverage && (coverage.hasGaps || coverage.warnings.length > 0 || coverage.recordedSince) && (
        <div className="coverage-note">
          <Icon name="alert" size={15} />
          <span>
            {coverage.recordedSince
              ? `记录始于 ${new Date(coverage.recordedSince).toLocaleString()}`
              : "记录范围有限"}
            {coverage.hasGaps ? " · 部分消息可能缺失" : ""}
            {coverage.warnings.length > 0 ? ` · ${coverage.warnings.join("；")}` : ""}
          </span>
        </div>
      )}
      {state.cooperation?.nextBefore && (
        <button className="load-older" onClick={onLoadMore} disabled={loading}>
          加载更早的消息
        </button>
      )}
      {messages.length ? (
        messages.map((message) => (
          <article className="collab-row" key={message.id}>
            <Avatar label={label(message.from)} tone="owner" />
            <div className="collab-content">
              <div className="collab-meta">
                <button
                  className="collab-from"
                  onClick={() => openOwner(message.from)}
                >
                  {label(message.from)}
                </button>
                {message.to === "*" ? (
                  <span className="collab-to">全体</span>
                ) : (
                  <button className="collab-mention" onClick={() => openOwner(message.to)}>
                    @{label(message.to)}
                  </button>
                )}
                <time>{formatTime(message.ts)}</time>
              </div>
              <div className="collab-bubble">
                <Markdown>{message.body}</Markdown>
              </div>
              {message.delivery.outcome.toLowerCase() !== "injected" && (
                <div
                  className={`delivery-state delivery-${message.delivery.outcome.toLowerCase()}`}
                >
                  <span />
                  {message.delivery.outcome}
                  {message.delivery.buffered ? " · 已缓冲" : ""}
                  {message.delivery.error ? ` · ${message.delivery.error}` : ""}
                </div>
              )}
            </div>
          </article>
        ))
      ) : loading ? (
        <div className="feed-empty">
          <span className="spinner" />
          载入协作记录…
        </div>
      ) : (
        <div className="feed-empty">
          <Icon name="message" size={20} />
          <strong>暂无协作消息</strong>
          <span>这里会显示 owner 之间实际投递的消息。</span>
        </div>
      )}
    </div>
  );
}

function connectionText(state: WebClientState): string {
  if (state.connection === "connected") return "已连接";
  if (state.connection === "syncing") return "正在同步";
  if (state.connection === "error") return "连接异常";
  return "未连接";
}

function receiptText(status: "received" | "admitted" | "handled" | "rejected"): string {
  if (status === "received") return "正在确认输入";
  if (status === "admitted") return "消息已受理";
  if (status === "handled") return "输入已处理";
  return "消息未受理";
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);
