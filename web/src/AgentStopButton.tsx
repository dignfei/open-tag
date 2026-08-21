import { useState } from "react";
import { Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { requestAgentStop } from "./lib/agentStop.ts";
import { useStore } from "./store.tsx";
import { useToast } from "./toast.tsx";

export function AgentStopButton({ agentId, className = "", iconSize = 12 }: { agentId: string; className?: string; iconSize?: number }) {
  const { t } = useTranslation();
  const { api, capabilities } = useStore();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  if (!capabilities.manageAgents) return null;

  const label = t(stopping ? "members.stopping" : "members.stop");
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await requestAgentStop(api, agentId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(t("members.stopFailedWithReason", { reason }));
    } finally {
      setStopping(false);
    }
  };

  return (
    <button
      type="button"
      className={`agent-stop-btn${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      aria-busy={stopping}
      disabled={stopping}
      onClick={(event) => { event.stopPropagation(); void stop(); }}
    >
      <Square size={iconSize} aria-hidden="true" />
    </button>
  );
}
