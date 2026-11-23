/**
 * 登录页 —— 双模式：
 *
 *   · OIDC 模式（生产，AUTH_DEV_MODE=false）：跳转 Keycloak 授权码 + PKCE 统一登录。
 *   · 开发态模式（AUTH_DEV_MODE=true）：直接选择身份，便于本地联调与自动化验收。
 *
 * 模式由网关 `GET /v1/auth/config` 下发，前端不自行猜测。
 */
import { useState, type FormEvent } from 'react';
import {
  BookOpen,
  Sparkles,
  GaugeCircle,
  KeyRound,
  Loader2,
  MessagesSquare,
  ShieldCheck,
} from 'lucide-react';
import { devLogin, ApiError } from '../api';
import { ROLES, SENSITIVITIES, type AuthConfig, type Identity } from '../types';
import { roleLabel, sensitivityLabel } from '../format';
import { ThemeToggle } from '../components/ThemeToggle';
import { startOidcLogin } from '../oidc';

export interface LoginPageProps {
  onLogin: (token: string, identity: Identity, expiresIn: number) => void;
  config: AuthConfig | null;
  configError: string | null;
  onRetryConfig: () => void;
}

const PLATFORM_FEATURES = [
  { label: 'Agent 对话', description: '工具编排与流式响应', icon: MessagesSquare },
  { label: '知识检索', description: '企业文档统一问答', icon: BookOpen },
  { label: '安全与审批', description: '权限隔离与人工确认', icon: ShieldCheck },
  { label: '运营治理', description: '预算、审计与调用追踪', icon: GaugeCircle },
];

/** 登录卡片外壳 */
function LoginCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background relative min-h-screen overflow-hidden">
      <div className="bg-primary/5 pointer-events-none absolute -start-40 -top-40 size-[30rem] rounded-full blur-3xl" aria-hidden="true" />
      <div className="bg-accent/50 pointer-events-none absolute -bottom-48 -end-32 size-[28rem] rounded-full blur-3xl" aria-hidden="true" />
      <div className="absolute end-4 top-4 z-10 sm:end-6 sm:top-6">
        <ThemeToggle />
      </div>

      <main className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-20 lg:px-10">
        <section className="hidden lg:block" aria-label="平台简介">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary ring-primary/15 flex size-10 items-center justify-center rounded-xl ring-1">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold">企业级 AI Agent 平台</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Enterprise AI Agent Platform</p>
            </div>
          </div>

          <div className="mt-14">
            <span className="bg-primary/10 text-primary inline-flex rounded-full px-3 py-1 text-xs font-medium">
              统一企业智能工作台
            </span>
            <h1 className="mt-5 max-w-xl text-4xl leading-tight font-semibold tracking-tight">
              一个入口，连接<br />企业<span className="text-primary">知识、工具与业务</span>。
            </h1>
            <p className="text-muted-foreground mt-5 max-w-lg text-sm leading-7">
              从智能问答到业务执行，在同一工作台中完成协作，并保持统一身份、权限边界与审计记录。
            </p>
          </div>

          <div className="mt-10 grid max-w-xl grid-cols-2 gap-3">
            {PLATFORM_FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.label} className="border-border/80 bg-card/70 flex items-center gap-3 rounded-xl border p-4 shadow-sm">
                  <span className="bg-secondary text-secondary-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{feature.label}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="login-card border-border bg-card w-full max-w-md justify-self-center rounded-xl border p-6 shadow-sm sm:p-8 lg:max-w-none" aria-label="登录工作台">
          <div className="login-brand mb-7 flex items-center gap-3 lg:hidden">
            <span className="bg-primary/10 text-primary ring-primary/15 flex size-10 shrink-0 items-center justify-center rounded-xl ring-1">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight">企业级 AI Agent 平台</h1>
              <p className="text-muted-foreground mt-0.5 text-xs">统一企业智能工作台</p>
            </div>
          </div>
          <div className="mb-6 hidden lg:block">
            <h2 className="text-xl font-semibold tracking-tight">登录工作台</h2>
            <p className="text-muted-foreground mt-1.5 text-sm">使用企业身份进入统一工作台。</p>
          </div>
          {children}
          <div className="border-border/80 text-muted-foreground mt-6 flex items-center justify-center gap-1.5 border-t pt-4 text-xs">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            统一身份认证 · 权限隔离 · 审计留痕
          </div>
        </section>
      </main>
    </div>
  );
}

/** 表单字段 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="field-label text-muted-foreground mb-1 block text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLASS =
  'border-input bg-background focus:border-ring focus:ring-ring/20 h-9 w-full rounded-md border px-3 text-sm outline-none transition-shadow focus:ring-2';

export function LoginPage({ onLogin, config, configError, onRetryConfig }: LoginPageProps) {
  const [role, setRole] = useState<string>('employee');
  const [tenantId, setTenantId] = useState('t-default');
  const [deptId, setDeptId] = useState('dept-general');
  const [sensitivity, setSensitivity] = useState<string>('internal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await devLogin({ role, tenantId: tenantId.trim(), deptId: deptId.trim(), sensitivity });
      onLogin(res.access_token, res.identity, res.expires_in);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  /** 跳转 Keycloak 统一登录 */
  const startSso = async (): Promise<void> => {
    if (!config) return;
    setSubmitting(true);
    setError(null);
    try {
      await startOidcLogin(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法发起统一登录');
      setSubmitting(false);
    }
  };

  /* ---------------- 配置加载中 ---------------- */
  if (!config && !configError) {
    return (
      <LoginCard>
        <p className="login-note text-muted-foreground flex items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          正在读取鉴权配置…
        </p>
      </LoginCard>
    );
  }

  /* ---------------- 配置读取失败 ---------------- */
  if (!config) {
    return (
      <LoginCard>
        <p className="login-error border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm" role="alert">
          {configError ?? '无法获取鉴权配置'}
        </p>
        <button
          type="button"
          onClick={onRetryConfig}
          className="login-submit bg-primary text-primary-foreground hover:bg-primary/90 h-9 w-full rounded-md text-sm font-medium transition-colors"
        >
          重试
        </button>
      </LoginCard>
    );
  }

  /* ---------------- OIDC 统一登录 ---------------- */
  if (config.mode === 'oidc') {
    return (
      <LoginCard>
        {error ? (
          <p
            className="login-error border-destructive/30 bg-destructive/5 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <button
          type="button"
          disabled={submitting}
          onClick={() => void startSso()}
          className="login-submit bg-primary text-primary-foreground hover:bg-primary/90 flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-60"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {submitting ? '跳转中…' : '使用企业账号登录'}
        </button>

        <div className="login-note bg-muted/40 text-muted-foreground mt-5 rounded-lg px-3 py-3 text-xs leading-relaxed">
          <ul className="list-disc space-y-1.5 ps-4 marker:text-primary/70">
            <li>Keycloak 统一认证（授权码 + PKCE）</li>
            <li>租户、部门、角色与密级访问控制</li>
            <li>
              <span>身份源</span>
              <code className="text-foreground mt-1 block break-all font-mono text-[11px]">{config.issuer}</code>
            </li>
          </ul>
        </div>
      </LoginCard>
    );
  }

  /* ---------------- 开发态身份选择 ---------------- */
  return (
    <LoginCard>
      <form onSubmit={submit}>
        <Field label="角色">
          <select className={INPUT_CLASS} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel(item)}（{item}）
              </option>
            ))}
          </select>
        </Field>

        <Field label="租户 ID">
          <input
            className={INPUT_CLASS}
            type="text"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="t-default"
            autoComplete="off"
          />
        </Field>

        <Field label="部门 ID">
          <input
            className={INPUT_CLASS}
            type="text"
            value={deptId}
            onChange={(e) => setDeptId(e.target.value)}
            placeholder="dept-general"
            autoComplete="off"
          />
        </Field>

        <Field label="数据密级">
          <select className={INPUT_CLASS} value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
            {SENSITIVITIES.map((item) => (
              <option key={item} value={item}>
                {sensitivityLabel(item)}（{item}）
              </option>
            ))}
          </select>
        </Field>

        {error ? (
          <p
            className="login-error border-destructive/30 bg-destructive/5 text-destructive mb-3 rounded-lg border px-3 py-2 text-sm"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="login-submit bg-primary text-primary-foreground hover:bg-primary/90 h-9 w-full rounded-md text-sm font-medium transition-colors disabled:opacity-60"
        >
          {submitting ? '登录中…' : '进入控制台'}
        </button>

        <p className="login-note text-muted-foreground mt-4 text-xs leading-relaxed">
          当前为开发态登录接口（<code className="font-mono">POST /v1/auth/dev-token</code>），仅在网关开启
          <code className="font-mono"> AUTH_DEV_MODE </code>时可用。生产环境由 Keycloak 统一登录后下发 JWT。
        </p>
      </form>
    </LoginCard>
  );
}
