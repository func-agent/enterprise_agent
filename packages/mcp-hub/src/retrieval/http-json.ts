/**
 * 带请求体的 JSON HTTP 客户端。
 *
 * 为什么要自己实现：Infinity 的检索接口是 `GET /…/docs` + JSON body。
 * 但 WHATWG `fetch` 规范禁止 GET/HEAD 携带 body（undici 直接抛
 * "Request with GET/HEAD method cannot have body"），而 Infinity 官方示例
 * （example/http/*.sh）用的是 `curl --request GET --data …`。
 *
 * 这里用 node:http 直接发包，既满足 Infinity 的契约，也不引入额外依赖。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface JsonRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  timeoutMs?: number;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  body: any;
  text: string;
}

export async function jsonRequest(opts: JsonRequestOptions): Promise<JsonResponse> {
  const { method, url, body, timeoutMs = 30_000 } = opts;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;

  return new Promise<JsonResponse>((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(payload ? { 'content-length': String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = undefined;
          try {
            parsed = text.trim() ? JSON.parse(text) : {};
          } catch {
            parsed = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            body: parsed,
            text,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
