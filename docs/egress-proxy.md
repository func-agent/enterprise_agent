# 出网代理（Envoy）—— 唯一出口与 SNI 白名单

> 依据《企业级 AI Agent 平台建设方案》**8.3 出网安全** / **9.3 网络要求**：
> 「所有出网流量必须经过网关与出网代理」「业务组件禁止直连商业 API，必须经过 agentgateway + 出网代理」
> 「出网代理（Envoy/Nginx）—— SNI 白名单 + TLS 解密审计」

---

## 一、它管什么

出网代理是平台**唯一**能访问外网的东西。商业大模型 API（MiniMax / 通义 / DeepSeek / 智谱 / OpenAI）的
每一次调用都必须从它出去，外网流量不绕开它。

| 端口 | 用途 | 谁在用 |
|---|---|---|
| `15000` | HTTP 正向代理（明文 HTTP + CONNECT 隧道） | **网关运行时走这条** |
| `15001` | TLS 解密监听（TLS inspector 读 SNI → 过滤链 → 解密审计） | 合规取证时用，客户端需信任企业 CA |
| `9901` | Envoy 管理接口（`/ready`、`/stats`、`/config_dump`） | 健康探针与验收脚本 |

白名单由环境变量 `EGRESS_ALLOWED_HOSTS` 驱动，`entrypoint.sh` 用 `render-allowlist.awk`
把 `envoy.yaml` 模板里的三个区块重新渲染出来（HTTP vhost / SNI 过滤链 / 上游集群）。
**白名单之外的域名一律 403。**

---

## 二、双层白名单

```
业务代码 ──①应用层白名单──▶ 网关 ──②网络层白名单──▶ Envoy ──▶ 商业大模型 API
            isEgressAllowed()      CONNECT/SNI 过滤
            （先判域名，再发请求）   （不在白名单 → 403）
```

- **① 应用层**：`packages/gateway/src/llm/providers.ts` 的 `assertEgressAllowed()`。
  域名不在白名单 → 直接抛 `ProviderError(403)`，请求根本不发出去。
- **② 网络层**：Envoy 侧的 SNI / Host 过滤。即使有人绕过应用层直接连 Envoy，非白名单域名仍然 403。

内网服务（TEI / Infinity / RAGFlow / DB-GPT）走 `assertEgressAllowedLocal()`，
只允许环回与私有网段，**不经过出网代理** —— 数据不出域。

---

## 三、网关怎么接的

`packages/gateway/src/llm/egress.ts` 是唯一的出口封装：

```ts
export async function egressFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxyUrl = config.gateway.egressProxyUrl?.trim();
  if (!proxyUrl) return fetch(url, init);          // 本地开发形态
  const agent = await resolveProxyAgent(proxyUrl);  // undici ProxyAgent
  const undici = await import('undici');
  return undici.fetch(url, { ...init, dispatcher: agent });
}
```

- 代理客户端用 **undici `ProxyAgent`**（已加入 `packages/gateway/package.json` 依赖）。
- Anthropic 与 OpenAI 两个协议适配器都改走 `egressFetch()`；TEI 适配器保持直连（内网）。
- **失败关闭**：配置了代理却加载不了代理客户端时直接抛错，**绝不静默回落成直连**。
- **启动守卫**：`EAP_ENVIRONMENT=production|staging` 时若 `EGRESS_PROXY_URL` 为空，
  网关**拒绝启动**（`assertEgressProxyConfigured()`）。

配置项（根目录 `.env`）：

```bash
EGRESS_PROXY_URL=http://127.0.0.1:15000
EGRESS_ALLOWED_HOSTS=agent.minimaxi.com,api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn
```

---

## 四、怎么验证

```bash
# 1) 容器与健康探针
docker ps --filter name=eap-envoy --format '{{.Status}}'     # Up ... (healthy)
curl -s http://127.0.0.1:9901/ready                            # 200

# 2) 白名单内放行（响应来自真实上游，不是 Envoy 的 403）
curl -s -i -x http://127.0.0.1:15000 https://agent.minimaxi.com/ | head -1

# 3) 非白名单必须 403
curl -s -i -x http://127.0.0.1:15000 https://evil.example.com/ | head -1
# → HTTP/1.1 403 Forbidden

# 4) TLS 解密链路（客户端信任企业 CA）
curl -s --cacert deploy/compose/envoy/certs/ca.crt \
  --resolve agent.minimaxi.com:15001:127.0.0.1 \
  https://agent.minimaxi.com:15001/v1/text/chatcompletion_v2 -d '...'

# 5) 网关模型流量确实经代理（字节计数）
curl -s http://127.0.0.1:9901/stats \
  | grep upstream_cx_tx_bytes_total | grep agent_minimaxi
```

第 5 步**必须用字节计数**，不能用 `upstream_rq_2xx` —— 后者只在**新建 CONNECT 隧道**时 +1，
而 undici 会复用已建立的隧道，复用期间它不动，会误判成「代理没生效」。
`scripts/verify-heavy.sh` 的「Envoy 出网代理」段已经按字节计数断言，并额外检查
**网关进程对非回环地址的 443 直连数为 0**（唯一出口未被绕过）。

---

## 五、实测记录

| 项 | 结果 |
|---|---|
| 容器 | `eap-envoy`（envoyproxy/envoy:v1.31-latest），健康探针 `healthy` |
| 白名单内 | `CONNECT agent.minimaxi.com:443 → upstream=218.91.170.223:443 response=200` |
| 非白名单 | `CONNECT evil.example.com:443 → upstream=- response=403` |
| TLS 解密链路 | 走通，`egress-https` 访问日志记录 SNI 与上游 |
| 网关模型流量 | Envoy 上游字节计数随每次调用递增 |
| 直连绕过 | 网关进程非回环 443 直连数 = 0 |

---

## 六、两个踩过的坑

### 1. 出网代理曾经是死代码

`providers.ts` 里定义了 `proxyDispatcher()`，但：

1. 本项目是 ESM（`module: NodeNext`），`require('undici')` 在 ESM 下抛 `ReferenceError`，
   被 `catch` 静默吞掉 → 永远返回 `undefined`；
2. 就算不抛，**全项目没有任何调用点** —— 这个函数定义了却没人用。

结果是模型请求一直直连，Envoy 从未参与，而「看起来一切正常」。
修复：改为 `await import('undici')`，把 `egressFetch()` 接进两个协议适配器。

### 2. Envoy 镜像里没有 curl 也没有 wget

官方镜像刻意做小，只含 envoy 本体与 bash。
原健康探针 `curl -fsS http://127.0.0.1:9901/ready` 永远失败（`curl: not found`），
容器状态会一直卡在 `starting`。

修复：新增 `deploy/compose/envoy/healthcheck.sh`，用 bash 内建 `/dev/tcp` 发原始 HTTP 请求。
注意**必须显式用 bash 执行** —— `/bin/sh` 在 Ubuntu 上是 dash，不支持 `/dev/tcp`
（`CMD-SHELL` 默认走 `/bin/sh`，会报 `cannot create /dev/tcp/...: Directory nonexistent`）。
改用 `test: ["CMD", "/etc/envoy/healthcheck.sh"]` 才稳定。

---

## 七、生产落地

1. **证书**：把企业 CA 签发的服务端证书放进 `deploy/compose/envoy/certs/` 覆盖开发占位证书
   （SAN 覆盖全部白名单域名）；`ca.crt` 下发给需要解密审计的客户端信任库。
2. **凭据**：出网代理本身不持有商业 API Key。Key 全部托管在 `agentgateway`（见 8.5 凭证安全）。
3. **审计**：解密审计走 15001 —— Envoy 的访问日志按请求记录
   `method / authority / sni / upstream / response / duration`，可直接接入审计归档。
4. **域名变更**：改 `EGRESS_ALLOWED_HOSTS` 后需 `docker compose up -d envoy` 让白名单重新渲染，
   两层白名单（应用层 + Envoy）要同步改。
5. **Envoy 版本升级**：`deploy/compose/.env` 的 `ENVOY_IMAGE`；配置模板若用了新版废弃字段，
   启动会 fail closed（entrypoint 的证书检查 + 渲染检查），不会带病放行。
