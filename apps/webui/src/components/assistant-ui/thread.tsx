import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "./attachment";
import { MarkdownText } from "./markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./reasoning";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "./tool-group";
import { getToolRenderer } from "../tools/tool-ui-registry";
import { PendingInterruptCard } from "../tools/PendingInterruptCard";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpen,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileText,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  Sparkles,
  SquareIcon,
  Wrench,
} from "lucide-react";
import type { FC, ReactNode } from "react";
import type { AgUiInterrupt } from "@assistant-ui/react-ag-ui";

export const Thread: FC<{ modelSelector?: ReactNode }> = ({ modelSelector }) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "52rem",
        ["--composer-radius" as string]: "18px",
        ["--composer-padding" as string]: "12px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-10 flex flex-col gap-y-8 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer bg-background sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) pb-4 md:pb-6">
            <ThreadScrollToBottom />
            <Composer modelSelector={modelSelector} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="滚动到底部"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const TASK_STARTERS = [
  {
    title: '查找企业知识',
    description: '检索制度文档并归纳重点',
    prompt: '请检索企业知识库，总结员工年假管理制度的重点。',
    icon: BookOpen,
  },
  {
    title: '了解业务工具',
    description: '查看当前可调用的工具能力',
    prompt: '请列出当前可用的业务工具及其用途，不要执行任何写操作。',
    icon: Wrench,
  },
  {
    title: '起草工作内容',
    description: '生成总结、说明或分析初稿',
    prompt: '请起草一份本周工作总结模板，包含重点工作、问题与下周计划。',
    icon: FileText,
  },
];

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root my-auto flex grow flex-col justify-center px-2 py-8 sm:px-6">
      <div className="flex flex-col items-center text-center">
        <span className="bg-primary/10 text-primary mb-5 flex size-11 items-center justify-center rounded-2xl">
          <Sparkles className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">今天想完成什么工作？</h1>
        <p className="text-muted-foreground mt-3 max-w-lg text-sm leading-6">
          描述你的任务，智能助手将结合企业知识与业务工具协助完成。
        </p>
      </div>
      <div className="mt-8 grid w-full gap-2.5 sm:grid-cols-3">
        {TASK_STARTERS.map((starter) => {
          const Icon = starter.icon;
          return (
            <ThreadPrimitive.Suggestion key={starter.title} prompt={starter.prompt} send asChild>
              <button
                type="button"
                className="group border-border/80 bg-card hover:border-primary/30 hover:bg-accent/40 flex items-start gap-3 rounded-xl border p-3.5 text-left shadow-sm transition-colors sm:flex-col"
              >
                <span className="bg-secondary text-secondary-foreground group-hover:bg-primary/10 group-hover:text-primary flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{starter.title}</span>
                  <span className="text-muted-foreground mt-1 block text-xs leading-5">{starter.description}</span>
                </span>
              </button>
            </ThreadPrimitive.Suggestion>
          );
        })}
      </div>
    </div>
  );
};

const Composer: FC<{ modelSelector?: ReactNode }> = ({ modelSelector }) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="bg-background focus-within:border-ring/75 focus-within:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 flex w-full flex-col gap-2 rounded-(--composer-radius) border p-(--composer-padding) transition-shadow focus-within:ring-2 data-[dragging=true]:border-dashed"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="描述你的任务…"
            className="aui-composer-input placeholder:text-muted-foreground/80 max-h-40 min-h-14 w-full resize-none bg-transparent px-1.75 py-1 text-sm leading-6 outline-none"
            rows={1}
            submitMode="ctrlEnter"
            autoFocus
            aria-label="消息输入框"
          />
          <ComposerAction modelSelector={modelSelector} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <p className="text-muted-foreground px-1 text-center text-[11px]">AI 生成内容仅供参考，请核对重要信息</p>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ modelSelector?: ReactNode }> = ({ modelSelector }) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <ComposerAddAttachment />
        {modelSelector}
        <span className="text-muted-foreground hidden text-[11px] lg:inline">Enter 换行 · Ctrl + Enter 发送</span>
      </div>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="发送消息"
            side="bottom"
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-send size-8 rounded-full"
            aria-label="发送消息"
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel size-8 rounded-full"
            aria-label="停止生成"
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

function runErrorCopy(raw: string): { title: string; message: string } {
  if (raw.includes('deny-confidential-egress')) {
    return {
      title: '机密内容已停止发送',
      message: '机密数据不能发送至商业模型，请改用本地推理服务。普通演示请使用内部密级账号与模拟数据。',
    };
  }
  if (/HTTP 503|所有 Failover|未配置|未连接/.test(raw)) {
    return {
      title: '模型服务暂不可用',
      message: '当前没有可用的模型 Provider，请联系管理员检查凭证、网络连接与 Failover 配置。',
    };
  }
  if (/HTTP 401|HTTP 403/.test(raw)) {
    return {
      title: '当前请求未获授权',
      message: '请重新登录，或联系管理员检查账号权限与访问策略。',
    };
  }
  return {
    title: '本次请求未完成',
    message: '模型或工具调用失败，请稍后重试。如问题持续，请联系管理员。',
  };
}

const MessageError: FC = () => {
  const error = useAuiState((s) =>
    s.message.status?.type === 'incomplete' && s.message.status.reason === 'error'
      ? String(s.message.status.error ?? '未知错误')
      : undefined,
  );
  const copy = runErrorCopy(error ?? '');

  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <strong className="block font-medium">{copy.title}</strong>
        <p className="mt-1 text-xs leading-relaxed">{copy.message}</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs opacity-80">技术详情</summary>
          <pre className="bg-background/40 mt-2 max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{error}</pre>
        </details>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot defaultOpen={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "group-tool":
                return (
                  <ToolGroupRoot>
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call": {
                if (part.toolUI) return part.toolUI;
                const ToolRenderer = getToolRenderer(part.toolName);
                return <ToolRenderer {...part} />;
              }
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="助手正在工作"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <PendingInterrupts />
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        {/*
          Assistant branch picker intentionally omitted. The experimental
          @assistant-ui/react-ag-ui@0.0.34 runtime creates an optimistic
          placeholder assistant message at RUN_STARTED and reassigns its id when
          the first TEXT_MESSAGE_START arrives. Under real first-token latency
          that id swap is observed across renders, so the ExternalStore reconciler
          registers a phantom sibling → a confusing "2/2". The reply itself is
          correct (one POST /ag-ui, one assistant message on the backend). The
          user-message branch picker (for editing your own message) is kept.
          Proper fix: upgrade the AG-UI runtime once a version without the
          optimistic-reassign branch artifact is available.
        */}
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const PendingInterrupts: FC = () => {
  const message = useAuiState((s) => s.message);
  const status = message.status;
  const interrupts = getAguiInterrupts(message.metadata?.custom);
  if (
    status?.type !== "requires-action" ||
    status.reason !== "interrupt" ||
    interrupts.length === 0
  ) {
    return null;
  }

  return <PendingInterruptCard interrupts={interrupts} className="mt-3" />;
};

function getAguiInterrupts(custom: unknown): AgUiInterrupt[] {
  if (!isRecord(custom) || !isRecord(custom.agui)) return [];
  const interrupts = custom.agui.interrupts;
  return Array.isArray(interrupts) ? interrupts.filter(isAguiInterrupt) : [];
}

function isAguiInterrupt(value: unknown): value is AgUiInterrupt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.reason === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground col-start-3 row-start-2 -ms-1 flex gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="重新生成">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="更多"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content bg-popover text-popover-foreground z-50 min-w-32 overflow-hidden rounded-md border p-1 shadow-md"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              导出为 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-accent text-accent-foreground border-primary/10 rounded-2xl border px-4 py-2.5 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑" className="aui-user-action-edit p-4">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-muted ms-auto flex w-full max-w-[85%] flex-col rounded-2xl">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent p-4 text-sm outline-none"
          submitMode="ctrlEnter"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一条">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一条">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
