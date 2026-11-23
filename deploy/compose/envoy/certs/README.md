# 出网代理 TLS 解密证书目录

本目录存放 **出网代理（Envoy）用于 TLS 解密审计的服务端证书**，见《建设方案》8.3 出网安全：
「出网代理：唯一出口，SNI 域名白名单（仅商业 API 域名），TLS 解密审计」。

## 当前文件（开发/测试占位）

| 文件 | 说明 |
|---|---|
| `ca.crt` | 企业 CA 证书（占位）。**生产必须替换为企业 CA 签发的证书** |
| `ca.key` | CA 私钥（占位）。生产环境不应存放在代码库中 |
| `server.crt` | 出网代理服务端证书，SAN 覆盖白名单域名 |
| `server.key` | 出网代理服务端私钥 |

## 生成 / 替换

```bash
# 生成（SAN 自动取白名单域名）
cd deploy/compose
EGRESS_ALLOWED_HOSTS="api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn,agent.minimaxi.com" \
  ./envoy/generate-certs.sh
```

生产环境：把企业 CA 签发的 `server.crt` / `server.key` 放入本目录覆盖占位文件即可；
`ca.crt` 需要下发到客户端信任库，客户端才会信任出网代理的解密证书。

## 安全提示

- 本目录中的证书为 **POC 占位**，仅用于打通链路；上线前必须替换为受企业 CA 管控的证书。
- 证书缺失时 envoy 容器会 **直接退出（fail closed）**，不会退化为明文放行。
- 私钥权限为 `600`，属主 `101:101`（envoy 官方镜像的运行用户）。
