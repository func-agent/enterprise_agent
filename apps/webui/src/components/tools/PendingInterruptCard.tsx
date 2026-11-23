import { useState } from "react";
import { useAssistantRuntime } from "@assistant-ui/react";
import type {
  AgUiAssistantRuntime,
  AgUiInterrupt,
  AgUiResumeEntry,
} from "@assistant-ui/react-ag-ui";

import {
  ConfirmToolCard,
  type ConfirmDecision,
  type ConfirmToolCall,
} from "./ConfirmToolCard";

export function PendingInterruptCard({
  interrupts,
  className,
}: {
  interrupts: readonly AgUiInterrupt[];
  className?: string;
}) {
  const runtime = useAssistantRuntime() as AgUiAssistantRuntime;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toolCalls = interrupts.map(toToolCall);

  const resolve = async (_replyId: string, decisions: ConfirmDecision[]) => {
    setSubmitting(true);
    setError(null);
    try {
      const confirmedByTool = new Map(
        decisions.map((decision) => [decision.toolCallId, decision.confirmed]),
      );
      const responses: AgUiResumeEntry[] = interrupts.map((interrupt) => {
        const toolCallId = interrupt.toolCallId ?? interrupt.id;
        return {
          interruptId: interrupt.id,
          status: "resolved",
          payload: { approved: confirmedByTool.get(toolCallId) ?? false },
        };
      });
      await runtime.unstable_submitInterruptResponses(responses);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={className}>
      <ConfirmToolCard
        replyId={replyIdOf(interrupts)}
        toolCalls={toolCalls}
        onResolve={resolve}
        disabled={submitting}
      />
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function toToolCall(interrupt: AgUiInterrupt): ConfirmToolCall {
  const metadata = interrupt.metadata ?? {};
  return {
    id: interrupt.toolCallId ?? interrupt.id,
    name: text(metadata.toolName) ?? interrupt.reason,
    input: text(metadata.toolInput) ?? interrupt.message,
  };
}

function replyIdOf(interrupts: readonly AgUiInterrupt[]): string {
  const metadata = interrupts[0]?.metadata ?? {};
  return text(metadata.replyId) ?? interrupts[0]?.id ?? "";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
