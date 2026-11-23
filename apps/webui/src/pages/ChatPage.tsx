/**
 * 对话工作台 —— assistant-ui 消息界面 + AG-UI 标准事件流。
 * 会话导航由工作台外壳统一管理，这里只维护当前线程和待审批操作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuiState } from '@assistant-ui/react';

import { ApiError, decideApproval, errorMessage, listApprovals, listMessages, listModelConfigs, listModels } from '../api';
import type { Approval, Identity, VirtualModel } from '../types';
import { canDecideApproval, canViewAdminPages } from '../permissions';
import { useToast } from '../components/Toast';
import { ChatModelSelector } from '../components/ChatModelSelector';
import { Thread } from '../components/assistant-ui/thread';
import {
  AgentRuntimeProvider,
  useAgentThreadRegistry,
  type ThreadMessageLike,
} from '../runtime/AgentRuntimeProvider';

interface PendingApprovalsProps {
  approvals: Approval[];
  identity: Identity;
  deciding: string | null;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}

function PendingApprovals({ approvals, identity, deciding, onDecide }: PendingApprovalsProps) {
  return (
    <ul className="flex flex-col gap-2">
      {approvals.map((approval) => (
        <li key={approval.id} className="bg-background border-border rounded-xl border p-3 shadow-sm">
          <p className="break-words text-sm font-medium">{approval.tool}</p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {approval.reason || '该操作需要人工确认后继续。'}
          </p>
          <div className="mt-3">
            {canDecideApproval(identity, approval) ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={deciding === approval.id}
                  onClick={() => onDecide(approval.id, 'approved')}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                >
                  批准
                </button>
                <button
                  type="button"
                  disabled={deciding === approval.id}
                  onClick={() => onDecide(approval.id, 'rejected')}
                  className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                >
                  驳回
                </button>
              </div>
            ) : (
              <span className="text-muted-foreground text-xs">等待其他审批人处理</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SessionActivity({ onSettled }: { onSettled: (sessionId: string) => void }) {
  const running = useAuiState((state) => state.thread.isRunning);
  const { sessionId } = useAgentThreadRegistry();
  const wasRunning = useRef(running);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);
  useEffect(() => {
    if (wasRunning.current && !running) onSettledRef.current(sessionId);
    wasRunning.current = running;
  }, [running, sessionId]);
  return null;
}

export function ChatPage({
  identity,
  activeId,
  isActive,
  onSessionChange,
  onSessionSettled,
  isDraftSession,
  onUnauthorized,
}: {
  identity: Identity;
  activeId: string;
  isActive: boolean;
  onSessionChange: (sessionId: string) => void;
  onSessionSettled: (sessionId: string) => void;
  isDraftSession: (sessionId: string) => boolean;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const canSelectModel = canViewAdminPages(identity);
  const [modelOptions, setModelOptions] = useState<VirtualModel[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSelections, setModelSelections] = useState<Map<string, string>>(() => new Map());
  const selectedModel = modelSelections.get(activeId) ?? '';

  const loadApprovals = useCallback(async (): Promise<void> => {
    try {
      setApprovals(await listApprovals('pending'));
    } catch {
      /* 轮询失败静默处理，避免打扰 */
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
    const timer = window.setInterval(() => void loadApprovals(), 4000);
    return () => window.clearInterval(timer);
  }, [loadApprovals]);

  useEffect(() => {
    if (!canSelectModel) {
      setModelOptions([]);
      setDefaultModel('');
      setModelSelections(new Map());
      return;
    }
    if (!isActive) return;

    const controller = new AbortController();
    setModelsLoading(true);
    void Promise.all([listModels(controller.signal), listModelConfigs(controller.signal)])
      .then(([visible, configuration]) => {
        const available = visible.filter((model) => model.targets.some((target) => target.provider !== 'tei'));
        setModelOptions(available);
        setDefaultModel(configuration.defaultModel);
        const allowed = new Set(available.map((model) => model.id));
        setModelSelections((previous) => {
          const next = new Map([...previous].filter(([, model]) => allowed.has(model)));
          return next.size === previous.size ? previous : next;
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else toast.push(`模型列表加载失败：${errorMessage(err)}`, 'error');
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [canSelectModel, isActive, onUnauthorized, toast]);

  const loadHistory = useCallback(async (sessionId: string): Promise<readonly ThreadMessageLike[]> => {
    if (isDraftSession(sessionId)) return [];
    const raw = await listMessages(sessionId);
    return raw
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        createdAt: new Date(message.createdAt),
      }));
  }, [isDraftSession]);

  const decide = useCallback(async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
    setDeciding(id);
    try {
      await decideApproval(id, decision);
      toast.push(decision === 'approved' ? '已批准，工具将继续执行' : '已驳回该工具调用', 'success');
      await loadApprovals();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setDeciding(null);
    }
  }, [loadApprovals, toast]);

  const selectModel = useCallback((model: string): void => {
    setModelSelections((previous) => {
      const next = new Map(previous);
      if (model) next.set(activeId, model);
      else next.delete(activeId);
      return next;
    });
  }, [activeId]);

  const visibleApprovals = useMemo(() => {
    const scoped = approvals.filter((approval) => approval.sessionId === activeId);
    return scoped.length > 0 ? scoped : approvals;
  }, [approvals, activeId]);

  return (
    <AgentRuntimeProvider sessionId={activeId} model={selectedModel || undefined} onSessionChange={onSessionChange} loadHistory={loadHistory}>
      <SessionActivity onSettled={onSessionSettled} />
      <div className="flex h-full min-h-0 w-full">
        <section className="flex min-w-0 flex-1 flex-col">
          {visibleApprovals.length > 0 ? (
            <div className="border-border bg-muted/30 max-h-60 overflow-y-auto border-b p-3 xl:hidden">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="text-primary size-4" aria-hidden="true" />
                {visibleApprovals.length} 项操作等待确认
              </div>
              <PendingApprovals
                approvals={visibleApprovals}
                identity={identity}
                deciding={deciding}
                onDecide={(id, decision) => void decide(id, decision)}
              />
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Thread modelSelector={canSelectModel ? (
              <ChatModelSelector
                models={modelOptions}
                value={selectedModel}
                defaultModel={defaultModel}
                loading={modelsLoading}
                onChange={selectModel}
              />
            ) : undefined} />
          </div>
        </section>

        {visibleApprovals.length > 0 ? (
          <aside className="border-border bg-muted/20 hidden w-80 shrink-0 flex-col border-l xl:flex" aria-label="待审批操作">
            <div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <ShieldCheck className="text-primary size-4" aria-hidden="true" />
              <h2 className="text-sm font-medium">待审批</h2>
              <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">
                {visibleApprovals.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <PendingApprovals
                approvals={visibleApprovals}
                identity={identity}
                deciding={deciding}
                onDecide={(id, decision) => void decide(id, decision)}
              />
            </div>
          </aside>
        ) : null}
      </div>
    </AgentRuntimeProvider>
  );
}
