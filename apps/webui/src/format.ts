/** 展示层格式化工具 */

const ROLE_LABEL: Record<string, string> = {
  employee: '员工',
  manager: '主管',
  admin: '管理员',
  'platform-admin': '平台管理员',
};

const SENSITIVITY_LABEL: Record<string, string> = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function sensitivityLabel(level: string): string {
  return SENSITIVITY_LABEL[level] ?? level;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 0) return formatDateTime(iso);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDateTime(iso);
}

/** 绝对时间：MM-DD HH:mm:ss */
export function formatDateTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 时分秒（用于时间列，避免过长） */
export function formatTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 千分位 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('zh-CN');
}

/** token 数：超过 1 万显示为「万」 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`;
  return formatNumber(value);
}

/** 美元金额 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.0000';
  if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/** 百分比 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${(ratio * 100).toFixed(2)}%`;
}

/** 美化 JSON；非对象则原样返回 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 截断长文本 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
