import { Bot } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';
import type { VirtualModel } from '../types';

export function ChatModelSelector({
  models,
  value,
  defaultModel,
  loading,
  onChange,
}: {
  models: VirtualModel[];
  value: string;
  defaultModel: string;
  loading: boolean;
  onChange: (model: string) => void;
}) {
  const running = useAuiState((state) => state.thread.isRunning);
  const selected = models.find((model) => model.id === value);
  const defaultLabel = `缺省${defaultModel ? `（${defaultModel}）` : ''}`;

  return (
    <label
      className="text-muted-foreground flex min-w-0 items-center gap-1.5"
      title={selected?.description ?? '未手动选择时使用服务端缺省模型；实际目标与故障转移以审计 Trace 为准'}
    >
      <Bot className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">选择对话模型</span>
      <select
        aria-label="选择对话模型"
        className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring/50 h-8 min-w-0 max-w-40 cursor-pointer rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-56"
        value={value}
        disabled={running || loading}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{loading ? '模型加载中…' : defaultLabel}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id} title={model.description}>
            {model.id}
          </option>
        ))}
      </select>
    </label>
  );
}
