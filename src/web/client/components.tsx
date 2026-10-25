import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { WebBlock, WebEntry, WebTool, WebUIRequest, WebUIResponse } from "../contracts";

export type IconName =
  | "search"
  | "plus"
  | "menu"
  | "chevron"
  | "arrow"
  | "stop"
  | "more"
  | "panel"
  | "message"
  | "users"
  | "branch"
  | "terminal"
  | "clock"
  | "check"
  | "close"
  | "maximize"
  | "minimize"
  | "send"
  | "spark"
  | "alert"
  | "reload"
  | "hash";

const paths: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  arrow: <path d="M12 19V5m-7 7 7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  message: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="10" cy="7" r="4" />
      <path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="3" r="2" />
      <circle cx="6" cy="21" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 5v14m12-11a9 9 0 0 1-9 9" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6m8 14h8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m18 6-12 12M6 6l12 12" />,
  maximize: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
    </>
  ),
  minimize: <path d="M5 12h14" />,
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" />
      <path d="m19 14 1.3 2.7L23 18l-2.7 1.3L19 22l-1.3-2.7L15 18l2.7-1.3L19 14Z" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  reload: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" />
    </>
  ),
  hash: (
    <>
      <path d="M4 9h16M4 15h16M10 3 8 21m8-18-2 18" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Avatar({
  label,
  tone = "agent",
}: {
  label: string;
  tone?: "agent" | "user" | "owner";
}) {
  return (
    <span className={`avatar avatar-${tone}`} aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ToolCard({ tool, compact = false }: { tool: WebTool; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className={`tool-card${tool.isError ? " tool-error" : ""}${compact ? " tool-compact" : ""}`}
    >
      <button
        className="tool-heading"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Icon name="terminal" size={15} />
        <span>{tool.toolName}</span>
        {tool.isError && <span className="tool-error-label">失败</span>}
        <span className="tool-toggle">
          {open ? "收起" : "查看"} <Icon name="chevron" size={13} />
        </span>
      </button>
      {open && (
        <div className="tool-detail">
          {tool.args && (
            <>
              <div className="detail-label">输入</div>
              <pre>{tool.args}</pre>
            </>
          )}
          {tool.result && (
            <>
              <div className="detail-label">输出</div>
              <pre>{tool.result}</pre>
            </>
          )}
          {!tool.args && !tool.result && <div className="muted">暂无详情</div>}
        </div>
      )}
    </section>
  );
}

export function EntryBlocks({ entry }: { entry: WebEntry }) {
  return (
    <div className="entry-blocks">
      {entry.blocks.map((block, index) => (
        <Block key={`${entry.id}-${index}`} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: WebBlock }) {
  if (block.type === "tool") return <ToolCard tool={block.tool} />;
  if (block.type === "thinking")
    return (
      <details className="thinking-block">
        <summary>思考过程</summary>
        <Markdown>{block.text}</Markdown>
      </details>
    );
  if (block.type === "notice") return <div className="notice-block">{block.text}</div>;
  return <Markdown>{block.text}</Markdown>;
}

export function RequestCard({
  request,
  onRespond,
  disabled = false,
}: {
  request: WebUIRequest;
  onRespond: (response: WebUIResponse) => Promise<void>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(request.kind === "editor" ? request.prefill : "");
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = request.expiresAt <= now;
  const answer = async (response: WebUIResponse) => {
    if (busy || answered || expired || disabled) return;
    setBusy(true);
    setError("");
    try {
      await onRespond(response);
      setAnswered(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回应失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`request-card${expired ? " request-expired" : ""}`}>
      <div className="request-kicker">
        <Icon name="spark" size={14} /> 等待你的回应
      </div>
      <h3>{request.title}</h3>
      {request.kind === "confirm" && <p>{request.message}</p>}
      {request.kind === "select" && (
        <div className="request-options">
          {request.options.map((option) => (
            <button
              key={option}
              disabled={busy || answered || expired || disabled}
              onClick={() => void answer({ kind: "select", value: option })}
            >
              {option}
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
      )}
      {request.kind === "select" && (
        <div className="request-actions">
          <button
            className="button-secondary"
            disabled={busy || answered || expired || disabled}
            onClick={() => void answer({ kind: "select" })}
          >
            取消
          </button>
        </div>
      )}
      {request.kind === "confirm" && (
        <div className="request-actions">
          <button
            className="button-secondary"
            disabled={busy || answered || expired || disabled}
            onClick={() => void answer({ kind: "confirm", value: false })}
          >
            拒绝
          </button>
          <button
            className="button-primary"
            disabled={busy || answered || expired || disabled}
            onClick={() => void answer({ kind: "confirm", value: true })}
          >
            确认
          </button>
        </div>
      )}
      {(request.kind === "input" || request.kind === "editor") && (
        <>
          {request.kind === "editor" ? (
            <textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy || answered || expired || disabled}
              rows={6}
            />
          ) : (
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder ?? "输入回应"}
              disabled={busy || answered || expired || disabled}
            />
          )}
          <div className="request-actions">
            <button
              className="button-secondary"
              disabled={busy || answered || expired || disabled}
              onClick={() => void answer({ kind: request.kind, value: undefined })}
            >
              取消
            </button>
            <button
              className="button-primary"
              disabled={busy || answered || expired || disabled}
              onClick={() => void answer({ kind: request.kind, value })}
            >
              提交
            </button>
          </div>
        </>
      )}
      <div className="request-foot">
        {answered
          ? "已回应"
          : expired
            ? "请求已过期"
            : disabled
              ? "同步完成后可回应"
              : busy
                ? "正在提交…"
                : `有效至 ${new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
      </div>
      {error && <div className="inline-error">{error}</div>}
    </article>
  );
}

export function formatTime(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
