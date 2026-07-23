import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, Check, ChevronRight, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentActivityItem } from "./store.tsx";

export type AgentRunPhase = "thinking" | "working" | "error" | null;

export function agentRunPhase(items: AgentActivityItem[] = [], state?: string | null): AgentRunPhase {
  if (state === "error") return "error";
  if (state !== "running") return null;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.activity === "error") return "error";
    if (["online", "sleeping", "offline"].includes(item.activity ?? "")) return null;
    if (item.activity === "thinking" || item.activity === "working") return item.activity;
    if (item.kind === "tool_start") return "working";
    if (item.kind === "thinking" || item.kind === "text") return "thinking";
  }

  return "working";
}

function eventTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function eventSummary(item?: AgentActivityItem): string {
  if (!item) return "";
  if (item.kind === "tool_start") return item.toolName || "tool";
  if (item.text) return item.text;
  return [item.activity, item.detail].filter(Boolean).join(" · ");
}

export function AgentActivityDisclosure({ items = [], state = "handled", receipt = false, autoOpenWhenLive = false }: { items?: AgentActivityItem[]; state?: string | null; receipt?: boolean; autoOpenWhenLive?: boolean }) {
  const { t } = useTranslation();
  const phase = useMemo(() => agentRunPhase(items, state), [items, state]);
  const live = phase === "thinking" || phase === "working";
  const failed = phase === "error";
  const [open, setOpen] = useState(autoOpenWhenLive && live);
  const wasLive = useRef(autoOpenWhenLive && live);
  useEffect(() => {
    if (!autoOpenWhenLive) return;
    if (live) { wasLive.current = true; setOpen(true); return; }
    if (!wasLive.current) return;
    wasLive.current = false;
    const timer = window.setTimeout(() => setOpen(false), 900);
    return () => window.clearTimeout(timer);
  }, [autoOpenWhenLive, live]);
  const summary = useMemo(() => eventSummary(items[items.length - 1]), [items]);
  const label = receipt
    ? (failed ? t("chat.agentFailed") : t("chat.agentHandled"))
    : phase === "thinking" ? t("liveBar.thinking")
      : phase === "working" ? t("chat.agentWorking")
        : t("chat.activity");
  if (!items.length && !live) return null;
  return (
    <div className={`msg-act${live ? " is-live" : ""}${failed ? " is-error" : ""}${receipt ? " is-receipt" : ""}`}>
      <button className="msg-act-toggle" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="msg-act-state" aria-hidden="true">{failed ? <AlertCircle size={14} /> : live ? <Activity size={14} /> : <Check size={14} />}</span>
        <span className="msg-act-label">{label}</span>
        <span className="msg-act-summary">{summary}</span>
        <span className="msg-act-count">{t("chat.activityCount", { count: items.length })}</span>
        <ChevronRight className="msg-act-chevron" size={14} aria-hidden="true" />
      </button>
      <div className={`msg-act-reveal${open ? " is-open" : ""}`} aria-hidden={!open}><div className="msg-act-body">
        {items.map((item, index) => {
          const tool = item.kind === "tool_start";
          const text = tool ? item.toolName : item.text || [item.activity, item.detail].filter(Boolean).join(" · ");
          return <div className={`msg-act-event${tool ? " is-tool" : ""}${live && index === items.length - 1 ? " is-current" : ""}`} key={`${item.timestamp}-${index}`}>
            <time>{eventTime(item.timestamp)}</time>
            <span className="msg-act-mark" />
            <div className="msg-act-event-content">
              {tool ? <><span className="msg-act-kind"><Terminal size={12} />{text}</span>{item.toolInput ? <code>{item.toolInput}</code> : null}</>
                : <span>{text}</span>}
            </div>
          </div>;
        })}
      </div></div>
    </div>
  );
}
