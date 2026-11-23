/**
 * 出网代理客户端（见 8.3 出网安全 / 9.3 网络要求）
 *
 * 方案原文：
 *   · 「所有出网流量必须经过网关与出网代理」
 *   · 「业务组件禁止直连商业 API，必须经过 agentgateway + 出网代理」
 *   · 出网代理是唯一出口，SNI 域名白名单 + TLS 解密审计
 *
 * 因此商业大模型 API 的每一次请求都从本模块出去：
 *   1) 应用层白名单 —— providers.ts 的 assertEgressAllowed()（先判域名，再发请求）
 *   2) 网络层白名单 —— Envoy 侧 SNI/Host 过滤（非白名单直连返回 403）
 *
 * 两个 Envoy 监听端口的职责（见 deploy/compose/envoy/envoy.yaml）：
 *   15000  HTTP 正向代理 —— 网关用它发起 CONNECT 隧道（TLS 端到端，Envoy 做域名管控 + 访问审计）
 *   15001  TLS 解密监听 —— 客户端需信任企业 CA（certs/ca.crt），用于解密审计
 *
 * 这里用 15000：网关是通用 HTTP 客户端，走 CONNECT 隧道时 SNI 由客户端自己携带，
 * Envoy 依据 SNI 匹配白名单；报文内容不落 Envoy，审计以连接元数据为主。
 * 需要解密审计的场景（合规取证）由部署侧把 EGRESS_PROXY_URL 指向 15001 并下发企业 CA。
 *
 * ⚠ 失败关闭（fail-closed）：配置了出网代理却加载不了代理客户端时**直接抛错**，
 * 绝不静默回落成直连 —— 否则「唯一出口」就形同虚设。
 */
import { config, createLogger } from '@eap/platform-core';
import { isPrivateProviderHost } from './provider-config.js';

const log = createLogger('gateway:egress');

/** 代理客户端缓存（undici ProxyAgent 内部维持连接池，按代理地址复用） */
let agentPromise: Promise<unknown> | null = null;
let agentForUrl = '';

async function resolveProxyAgent(proxyUrl: string): Promise<unknown> {
  if (!agentPromise || agentForUrl !== proxyUrl) {
    agentForUrl = proxyUrl;
    agentPromise = (async () => {
      // 动态导入：本包是 ESM（module: NodeNext），require 不可用；
      // 早期实现里写成 require('undici')，在 ESM 下抛 ReferenceError 被 catch 吞掉，
      // 导致出网代理静默失效（模型请求一直直连）。此处改为 await import。
      const undici = await import('undici');
      const agent = new undici.ProxyAgent(proxyUrl);
      log.info('出网代理已启用', { proxyUrl });
      return agent;
    })().catch((err) => {
      // 失败关闭：代理不可用时不允许回落直连
      agentPromise = null;
      agentForUrl = '';
      throw new Error(
        `出网代理客户端加载失败（已拒绝直连以保证「唯一出口」）：${(err as Error)?.message ?? err}`,
      );
    });
  }
  return agentPromise;
}

/**
 * 经出网代理发起请求。
 *
 * @param url   目标地址（外部域名，或已由调用方判定为内网的地址）
 * @param init  与 fetch 相同的请求参数
 */
export async function egressFetch(url: string, init: RequestInit = {}, allowPrivateDirect = false): Promise<Response> {
  if (allowPrivateDirect && isPrivateProviderHost(new URL(url).hostname)) return fetch(url, init);
  const proxyUrl = config.gateway.egressProxyUrl?.trim();
  if (!proxyUrl) {
    // 未配置出网代理：本地开发形态直接出网。
    // 生产环境由 gateway 启动守卫拦截（见 assertEgressProxyConfigured）。
    return fetch(url, init);
  }
  const agent = await resolveProxyAgent(proxyUrl);
  const undici = await import('undici');
  return undici.fetch(url, { ...init, dispatcher: agent } as never) as unknown as Promise<Response>;
}

/**
 * 启动守卫：生产环境必须配置出网代理，否则直接拒绝启动。
 *
 * 依据 9.3 网络要求「所有出网流量必须经过网关与出网代理」，
 * 生产形态漏配代理 = 所有商业 API 调用绕过唯一出口，属于不可接受的安全缺口。
 */
export function assertEgressProxyConfigured(env: string = process.env.EAP_ENVIRONMENT ?? 'local'): void {
  const isProd = /^(prod|production|staging)$/i.test(env);
  if (!isProd) return;
  const proxyUrl = config.gateway.egressProxyUrl?.trim();
  if (!proxyUrl) {
    throw new Error(
      `EAP_ENVIRONMENT=${env} 要求配置出网代理，但 EGRESS_PROXY_URL 为空。` +
        '按 9.3 网络要求，商业 API 出网必须经 Envoy 唯一出口，拒绝启动。',
    );
  }
  log.info('出网代理配置校验通过', { proxyUrl, env });
}
