/**
 * 鉴权路由 —— 面向控制台的两类入口：
 *
 *   1. `GET  /v1/auth/config`  —— 公开端点，返回 OIDC 授权参数（公开客户端 + PKCE）。
 *      控制台据此判断走「Keycloak 统一登录」还是「开发态身份选择」。
 *   2. `POST /v1/auth/dev-token` —— 仅在 AUTH_DEV_MODE=true 时开放的开发态登录。
 *
 * 生产环境（AUTH_DEV_MODE=false）由 Keycloak 统一登录，本文件的 dev 端点自动失效。
 */
import { Router, type Request, type Response } from 'express';
import { config, createLogger, devTokenFor } from '@eap/platform-core';

const log = createLogger('gateway:route:auth');

/**
 * 从 Host 头取主机名（不含端口）。
 * 支持 IPv6 字面量（[::1]:8080）与裸主机名。
 */
function hostnameFromHostHeader(host: string | undefined): string {
  if (!host) return '127.0.0.1';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : '127.0.0.1';
  }
  const idx = host.lastIndexOf(':');
  return idx > 0 ? host.slice(0, idx) : host;
}

/**
 * 解析「用户实际访问的入口主机名」。
 *
 * 优先取 `x-forwarded-host`（反代透传的原始 Host），回退到 `host`。
 * 这一步很关键：控制台经 vite preview / Nginx / Envoy 反代时，Host 头会被
 * 改写成后端地址；只有 x-forwarded-host 保留「用户浏览器真正访问的地址」，
 * 浏览器据此才能拿到自己可达的 Keycloak 授权地址。
 */
function publicHostname(req: Request): string {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host;
  // x-forwarded-host 可能是 "a.com, b.com" —— 取第一个（最接近客户端的那个）
  const first = raw?.split(',')[0]?.trim();
  return hostnameFromHostHeader(first);
}

/**
 * Keycloak 浏览器侧可达的根地址（去掉结尾斜杠）。
 *
 * `KEYCLOAK_PUBLIC_URL` 里可以用 `{host}` 占位，运行时按**请求的 Host 头**
 * 替换主机名。这样同一份配置同时适配本机访问（Host=127.0.0.1）与
 * 公网访问（Host=公网 IP），浏览器拿到的授权/换令牌地址永远是自己可达的那个。
 */
function keycloakPublicBase(req: Request): string {
  const raw = config.auth.publicBaseUrl || config.auth.baseUrl;
  const resolved = raw.includes('{host}')
    ? raw.replace('{host}', publicHostname(req))
    : raw;
  return resolved.replace(/\/+$/, '');
}

export function authRoutes(): Router {
  const router = Router();

  /**
   * OIDC 授权配置 —— 公开端点（不鉴权）。
   * 控制台拿到后自行发起「授权码 + PKCE」跳转，
   * 令牌交换也在浏览器侧完成，网关不持有任何客户端密钥。
   */
  router.get('/v1/auth/config', (req: Request, res: Response) => {
    const base = keycloakPublicBase(req);
    const endpoint = `${base}/realms/${config.auth.realm}/protocol/openid-connect`;
    /**
     * issuer 必须与 Keycloak **实际签发的 iss** 逐字一致。
     *
     * Keycloak 默认按请求的 Host 头生成 issuer，所以这里跟着 host-rewritten 的
     * `base` 走 —— 公网访问得到公网 issuer，本机访问得到 127.0.0.1 issuer，
     * 两者都与 Keycloak 签发的一致。
     *
     * 不能直接取白名单第一项（`config.auth.issuer[0]`）：那是服务间地址
     * （127.0.0.1），外网用户看到的会是错的 issuer。后端验签仍用白名单数组
     * （auth-middleware），此处只影响控制台展示与前端对 iss 的自检。
     */
    const realmIssuer = `${base}/realms/${config.auth.realm}`;
    const issuer = config.auth.issuer.find((item) => item === realmIssuer) ?? realmIssuer;
    res.json({
      mode: config.auth.devMode ? 'dev' : 'oidc',
      clientId: config.auth.webClientId,
      scope: config.auth.webScope,
      authorizationUrl: `${endpoint}/auth`,
      tokenUrl: `${endpoint}/token`,
      endSessionUrl: `${endpoint}/logout`,
      issuer,
      /** 回调路径由控制台自行拼接 origin */
      redirectPath: '/auth/callback',
      devMode: config.auth.devMode,
    });
  });

  router.post('/v1/auth/dev-token', async (req: Request, res: Response) => {
    if (!config.auth.devMode) {
      res.status(404).json({ error: 'not_found', message: '开发登录接口已关闭' });
      return;
    }
    const b = req.body ?? {};
    const role = String(b.role ?? 'employee');
    const tenantId = String(b.tenant_id ?? config.auth.defaultTenantId);
    const deptId = String(b.dept_id ?? 'dept-general');
    const sensitivity = String(b.sensitivity ?? 'internal');
    try {
      const token = await devTokenFor(`dev-${role}`, {
        tenantId,
        role,
        deptId,
        sensitivity: sensitivity as 'public' | 'internal' | 'confidential',
      });
      log.info('签发开发令牌', { role, tenantId, deptId });
      res.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        identity: { tenant_id: tenantId, user_id: `dev-${role}`, role, dept_id: deptId, sensitivity },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? '签发失败' });
    }
  });

  return router;
}
