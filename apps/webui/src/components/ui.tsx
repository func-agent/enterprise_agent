/**
 * 轻量 UI 原子组件 —— Tailwind 4 + 设计令牌（浅色 / 深色主题，企业深蓝主色）。
 *
 * 组件 API 保持不变（与改版前一致），只把样式换成新设计系统的工具类，
 * 这样页面层无需改动结构即可继承新皮肤。
 */
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

/**
 * 徽标色调 → 语义位。
 *
 * 沿用 shadcn 的语义分层：neutral 走「次级面 + 次级字」（中性位），
 * primary 走实心主色（强调位），success / warning / error 是状态位。
 * 颜色一律由令牌驱动，组件不写死颜色值。
 *
 * neutral 之所以不是灰：令牌里的 --secondary / --secondary-foreground 已调成蓝调，
 * 因此它显示为浅蓝底 + 深蓝字，与整套蓝调一致。
 */
const BADGE_TONE: Record<string, string> = {
  neutral: 'border-border bg-secondary text-secondary-foreground',
  primary: 'border-transparent bg-primary text-primary-foreground',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
};

/** 状态徽标 */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'error';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE_TONE[tone] ?? BADGE_TONE.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 成功 / 失败徽标 */
export function StatusBadge({
  ok,
  okText = '成功',
  failText = '失败',
}: {
  ok: boolean;
  okText?: string;
  failText?: string;
}) {
  return (
    <Badge tone={ok ? 'success' : 'error'}>{ok ? okText : failText}</Badge>
  );
}

/** 加载态 */
export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
      <span
        className="border-primary/25 border-t-primary size-4 animate-spin rounded-full border-2"
        aria-hidden="true"
      />
      <span>{text}</span>
    </div>
  );
}

/** 空状态 */
export function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="border-border/70 bg-muted/30 flex flex-col items-center gap-1 rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{text}</p>
      {hint ? <p className="text-muted-foreground max-w-md text-xs">{hint}</p> : null}
    </div>
  );
}

/** 错误提示块（区别于 toast，用于页面主体） */
export function ErrorNotice({
  title = '加载失败',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 text-destructive flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm"
    >
      <div className="flex flex-col gap-0.5">
        <strong className="font-medium">{title}</strong>
        {/* 校验错误会一次列出多个问题（每行一条）—— 必须保留换行 */}
        <span className="text-destructive/90 whitespace-pre-line">{message}</span>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="border-destructive/40 hover:bg-destructive/10 shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}

/** 权限不足提示（非管理员访问管理接口时） */
export function ForbiddenNotice({ message = '需要管理员权限' }: { message?: string }) {
  return (
    <div
      role="alert"
      className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 flex flex-col gap-0.5 rounded-lg border px-4 py-3 text-sm"
    >
      <strong className="font-medium">权限不足</strong>
      <span>{message}。请使用 admin 或 platform-admin 角色登录后查看。</span>
    </div>
  );
}

/** 卡片容器 */
export function Panel({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-border bg-card rounded-xl border shadow-sm', className)}>
      {title || extra ? (
        <header className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          {extra ? <div className="flex items-center gap-2">{extra}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** 预算使用率进度条 */
export function UsageBar({ ratio }: { ratio: number }) {
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
  const tone =
    ratio >= 1
      ? 'bg-red-500'
      : ratio >= 0.8
        ? 'bg-amber-500'
        : 'bg-primary';
  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${safe * 100}%` }} />
      </div>
      <span
        className={cn(
          'w-14 text-end text-xs tabular-nums',
          ratio >= 1
            ? 'text-red-600 dark:text-red-400'
            : ratio >= 0.8
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
        )}
      >
        {(ratio * 100).toFixed(1)}%
      </span>
    </div>
  );
}

/** 页面级容器 —— 统一内边距与最大宽度 */
export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full max-w-[90rem] px-4 py-5 sm:px-6 lg:px-8', className)}>{children}</div>;
}

/** 页面标题区 */
export function PageHead({
  title,
  subtitle,
  description,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 sm:gap-y-0">
      <h1 className="page-title">{title}</h1>
      {actions ? <div className="page-actions ml-auto shrink-0 justify-end">{actions}</div> : null}
      {subtitle || description ? (
        <div className="min-w-0 basis-full sm:col-span-full">
          {subtitle ? <p className="page-subtitle whitespace-nowrap">{subtitle}</p> : null}
          {description ? <p className="text-muted-foreground mt-2 whitespace-nowrap text-xs">{description}</p> : null}
        </div>
      ) : null}
    </header>
  );
}

/** 分段切换控件 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="bg-muted inline-flex rounded-lg p-0.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          aria-pressed={value === item.key}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === item.key
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 键值详情网格 */
export function DetailGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{children}</div>;
}

/** 详情网格中的一项 */
export function DetailItem({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-dashed py-1.5 last:border-0">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <span className={cn('text-end text-xs', mono && 'font-mono break-all')}>{children}</span>
    </div>
  );
}

/** JSON 代码块 */
export function JsonBlock({ value, compact = false }: { value: string; compact?: boolean }) {
  return (
    <pre
      className={cn(
        'bg-muted/60 text-foreground overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed',
        compact ? 'max-h-32' : 'max-h-72',
      )}
    >
      {value}
    </pre>
  );
}
