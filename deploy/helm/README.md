# 企业级 AI Agent 平台 —— Helm Chart

依据《企业级 AI Agent 平台建设方案》**第 9 章 部署方案与硬件配置**：

| 方案章节 | 落地方式 |
|---|---|
| 9.1 硬件配置 | 生产 3 台 16C/48-64G/500G SSD，PG/Redis/Infinity 副本分布，网关多副本 |
| 9.2 部署形态 | 生产 K8s（或 K3s）+ Helm，**组件按层分 namespace**（`eap-support` / `eap-app` / `eap-data`） |
| 9.3 网络要求 | 内网互通；商业 API 只经 `agentgateway` → 出网代理（Envoy）出网 |
| 9.4 关键部署参数 | `DOC_ENGINE=infinity`、Infinity 数据持久卷、MinIO 版本化、**agentgateway 2 副本 + PDB** |

单机 POC 形态请用同级目录的 `../compose`（见该目录 README）。

---

## 一、目录结构

```
deploy/helm/
  Chart.yaml                  # apiVersion v2 / version 1.0.0 / appVersion 1.0.0，annotations 标注方案依据
  values.yaml                 # 分层配置：supportLayer / identityLayer / knowledgeLayer / chatbiLayer
                              #            gatewayLayer / appLayer / observabilityLayer / securityLayer / imageRegistry
  templates/
    _helpers.tpl              # 名称、标签、镜像拼接、namespace、存储类
    namespace.yaml            # eap-support / eap-app / eap-data
    configmap.yaml            # Web UI nginx 配置 + 平台共享配置
    secret.yaml               # 占位密钥（生产用 K8s Secret / 季度轮换，3.2 不引入 Vault）
    gateway-deployment.yaml   # agentgateway（2 副本 + PDB）
    agent-deployment.yaml     # AgentScope Service + MCP Hub
    webui-deployment.yaml     # AgentScope Web UI（唯一用户入口）
    support.yaml              # PostgreSQL / Redis / MinIO / ClickHouse
    keycloak.yaml             # Keycloak 26 + realm
    rag.yaml                  # RAGFlow + Infinity + TEI
    chatbi.yaml               # DB-GPT（MCP Server）
    langfuse.yaml             # Langfuse v3 web + worker
    envoy.yaml                # 出网代理（SNI 白名单 + TLS 解密审计）
    harbor.yaml               # Harbor 2.x（离线镜像仓，默认关闭）
    ingress.yaml              # 单一前端入口：/ → Web UI，/api → AgentScope，/v1 → 网关
```

渲染结果：3 Namespace、9 Deployment、8 StatefulSet、16 Service、6 ConfigMap、3 Secret、2 PDB、1 Job、1 Ingress。

---

## 二、安装步骤

### 2.1 前置条件

- Kubernetes ≥ 1.25（Ingress `networking.k8s.io/v1`）、Helm ≥ 3.8
- 已安装 ingress controller（本 chart 默认 `ingress.className: nginx`）
- 存储类：若集群无默认 StorageClass，在 values 中显式指定 `global.storageClass`

### 2.2 安装

```bash
# 1) 查看将要部署的资源
helm template eap ./deploy/helm --namespace eap-app | less

# 2) 创建命名空间（chart 内 namespace.yaml 也会创建，手工创建可先行校验）
kubectl create namespace eap-support
kubectl create namespace eap-app
kubectl create namespace eap-data

# 3) 覆盖密钥与域名后安装
helm upgrade --install eap ./deploy/helm \
  --namespace eap-app \
  --set imageRegistry=harbor.corp.example.com/eap \
  --set ingress.host=eap.example.com \
  --set-string gatewayLayer.gateway.providerCredentials.openai=sk-xxx \
  --wait --timeout 15m

# 4) 查看
kubectl get pods -n eap-app -o wide
kubectl get pdb -n eap-app            # agentgateway / agent-core 的 PDB
kubectl get ingress -n eap-app
```

> **强烈建议**：生产不要用 `--set` 传密钥，改为 `values-production.yaml` + `secrets.existingSecret`（见下）。

### 2.3 卸载

```bash
helm uninstall eap --namespace eap-app
# 注意：PVC 与 Harbor 镜像数据不会随 helm 删除自动清理，需按需手工处理
```

---

## 三、values 覆盖示例

### 3.1 生产环境典型覆盖（values-production.yaml）

```yaml
# —— 离线镜像仓（见 3.1「Harbor 2.x：离线镜像仓（内网环境必需）」）
imageRegistry: harbor.corp.example.com/eap

global:
  imagePullSecrets:
    - name: harbor-pull
  storageClass: nfs-client

# —— 9.4：agentgateway 2 副本 + PDB（默认值即为此）
gatewayLayer:
  gateway:
    replicaCount: 2
    pdb:
      enabled: true
      minAvailable: 1

# —— 密钥改由运维预先创建的 Secret 提供（3.2 不引入 Vault）
secrets:
  existingSecret: eap-platform-secret
  create: false

# —— 出网白名单（8.3 出网安全）
securityLayer:
  envoy:
    allowedHosts:
      - api.openai.com
      - dashscope.aliyuncs.com
      - api.deepseek.com
      - open.bigmodel.cn
      - agent.minimaxi.com
    tls:
      # 企业 CA 签发的解密证书
      existingSecret: eap-envoy-tls

# —— 资源与调度（9.1：生产 3 台 16C/48-64G）
supportLayer:
  postgres:
    resources:
      requests: { cpu: "2", memory: 8Gi }
      limits: { cpu: "4", memory: 16Gi }
nodeSelector:
  kubernetes.io/os: linux
tolerations:
  - key: eap
    operator: Equal
    value: "true"
    effect: NoSchedule
```

```bash
helm upgrade --install eap ./deploy/helm \
  --namespace eap-app -f values-production.yaml \
  --set secrets.existingSecret=eap-platform-secret
```

### 3.2 常用单项覆盖

```bash
# 只跑平台自研组件（其余对接已有实例）
helm upgrade --install eap ./deploy/helm -n eap-app \
  --set supportLayer.postgres.enabled=false \
  --set supportLayer.redis.enabled=false \
  --set supportLayer.minio.enabled=false \
  --set supportLayer.clickhouse.enabled=false \
  --set observabilityLayer.langfuse.enabled=false

# 关闭默认 Ingress，改由企业网关统一接入
helm upgrade --install eap ./deploy/helm -n eap-app --set ingress.enabled=false

# 打开内网镜像仓
helm upgrade --install eap ./deploy/helm -n eap-app --set harbor.enabled=true
```

---

## 四、PDB 与多副本说明（对应 9.4）

| 组件 | 副本 | PDB | 说明 |
|---|---|---|---|
| **agentgateway** | **2**（`gatewayLayer.gateway.replicaCount`） | `minAvailable: 1` | 方案明确要求：2 副本 + PDB。滚动升级时至少保留 1 个可用副本，避免网关整体不可用 |
| AgentScope Service | **1**（`appLayer.agentCore.replicaCount`） | 默认关闭 | 会话运行与删除互斥目前仅在进程内成立；多副本前需实现共享协调和会话持久化 |
| AgentScope Web UI | 2 | 无 | 纯静态资源，多副本由 Ingress 负载均衡 |
| MCP Hub | 1 | 无 | 有状态（SQLite 元数据存储），POC/中小规模单副本足够 |
| Envoy 出网代理 | 2 | 无 | 无状态，双副本互为备份 |
| PostgreSQL / Redis / MinIO / ClickHouse | 1（StatefulSet） | — | 生产多副本需由运维做流复制 / 分片方案（见 9.4「PG：3 副本 + 流复制」） |

调整方式：

```bash
# 网关扩到 3 副本并把 PDB 改为 minAvailable=2
helm upgrade eap ./deploy/helm -n eap-app \
  --set gatewayLayer.gateway.replicaCount=3 \
  --set gatewayLayer.gateway.pdb.minAvailable=2
```

**PDB 使用限制**：只有 `minAvailable < replicas` 才能在不降低可用副本数的前提下驱逐 Pod。
Agent Core 默认单副本且关闭 PDB；完成共享协调和会话持久化后，才可扩到多副本并启用 PDB。

---

## 五、离线镜像仓（Harbor）接入

### 5.1 部署 Harbor

```bash
helm upgrade --install harbor ./deploy/helm -n eap-support \
  --set harbor.enabled=true \
  --set imageRegistry=harbor.corp.example.com/eap
```

或直接使用 Harbor 官方 chart（本 chart 内置的是精简版 registry + core）：

```bash
helm repo add harbor https://helm.goharbor.io
helm install harbor harbor/harbor -n harbor --create-namespace \
  --set database.type=internal --set redis.type=internal
```

### 5.2 推镜像到 Harbor

```bash
for img in postgres:16 redis:7 clickhouse/clickhouse-server:24.8-alpine \
           infiniflow/ragflow:v0.22.1 infiniflow/infinity:v0.6.5 \
           ghcr.io/huggingface/text-embeddings-inference:cpu-1.8 \
           langfuse/langfuse:3.63.0 langfuse/langfuse-worker:3.63.0 \
           quay.io/keycloak/keycloak:26.0 envoyproxy/envoy:v1.31-latest \
           eosphorosai/dbgpt:latest mysql:8.0.39; do
  name=$(echo "$img" | tr '/:' '__')
  docker pull "$img"
  docker tag  "$img" "harbor.corp.example.com/eap/$name"
  docker push "harbor.corp.example.com/eap/$name"
done
```

### 5.3 让平台从 Harbor 拉取

```yaml
imageRegistry: harbor.corp.example.com/eap
global:
  imagePullSecrets:
    - name: harbor-pull
```

chart 内所有镜像地址都由 `imageRegistry` + `repository` + `tag` 拼装（见 `_helpers.tpl` 的 `eap.image`），因此**只需设置一个前缀**，无需逐个改写。

### 5.4 模型仓

镜像内不含模型（见 4.2「v0.22+ 不含 Embedding 模型」）：

- **TEI**：把 `BAAI/bge-m3` 放到内网 HTTP 模型仓，配置 `knowledgeLayer.tei.model.endpoint`（HF_ENDPOINT）；或把模型目录挂到 PVC 后设置 `--model-id /data/<目录>`。
- **RAGFlow**：DeepDoc 解析模型同样需要内网化。
- **DB-GPT**：Text2SQL 依赖的模型可指向内网或经网关调用商业 API。

---

## 六、生产落地检查清单

- [ ] `secrets.existingSecret` 指向运维创建的 Secret，所有 `CHANGE_ME_*` 已替换（8.5 凭证安全）
- [ ] 出网代理 TLS 证书为企业 CA 签发，CA 已下发到客户端信任库（8.3 出网安全）
- [ ] `EGRESS_ALLOWED_HOSTS` / `securityLayer.envoy.allowedHosts` 只保留必需域名
- [ ] agentgateway 2 副本 + PDB 已生效（9.4）
- [ ] 网关网络策略限制为「仅能访问出网代理」（9.3 网络要求）
- [ ] `AUTH_DEV_MODE` 未开启，Keycloak issuer 与外部访问地址一致
- [ ] MinIO 桶已开启版本化（`minio-init` Job 执行成功）
- [ ] Langfuse 唯一观测点接入完成，未额外部署 Prometheus / Grafana（3.2 明确排除）
