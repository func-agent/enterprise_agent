# Harbor 2.x —— 离线镜像仓

> 依据《企业级 AI Agent 平台建设方案》3.1 组件总览「镜像 / Harbor 2.x / P1 / 离线镜像仓（内网环境必需）」，
> 以及 9.2 部署形态「离线环境 = Harbor 镜像仓 + 内网 TEI 模型仓」。

---

## 一、为什么要跑 Harbor

方案把 Harbor 定位为**内网环境的镜像仓**：外网能拉到的镜像先进 Harbor，
内网的生产集群从 Harbor 拉，**生产环境不依赖外网**。

它同时是平台自举的一部分 —— 本项目自己的镜像（`eap/agentgateway` 等）也需要一个地方存放与分发。

---

## 二、卡点：goharbor 镜像拉不到

本网络**直连 Docker Hub 不可达**，而 Docker daemon 配的三个镜像加速站
（`docker.m.daocloud.io` / `docker.1panel.live` / `hub.rat.dev`）
**全部拒绝 `goharbor` 命名空间**。

实测记录（真实 `docker pull`，非 `docker manifest inspect` —— 后者客户端直连 registry、
不走 daemon 镜像加速，测出来的是假象）：

| 源 | goharbor 命名空间 | 结论 |
|---|---|---|
| `docker.m.daocloud.io` | HTTP 403 Forbidden | 拒绝 |
| `docker.1panel.live` | HTTP 403 Forbidden | 拒绝 |
| `hub.rat.dev` | not found | 拒绝 |
| `docker.1ms.run` / `docker.nju.edu.cn` / `docker.xuanyuan.me` | 403 / not found | 拒绝 |
| `mirror.gcr.io` / `dockerproxy.cn` / `dockerproxy.net` | 连接失败 / 404 | 不可用 |
| `ghcr.io/goharbor/*` | denied | Harbor 未发布到 GHCR |
| `quay.io/goharbor/*` | 无该仓库 | — |
| `registry-1.docker.io`（直连） | HTTP 000 | 网络不可达 |

换标签也不行（`latest` 与显式 `v2.15.5` 都试过）。

---

## 三、解法：官方离线安装包

Harbor 官方在 GitHub Releases 提供 **offline installer**，
内含**全部镜像的 tar 包 + 完整编排 + 配置模板**，`docker load` 之后可完全离线运行。

这恰好就是方案里「内网环境必需 / 离线镜像仓」的形态本身 —— 用它反而更贴题。

| 项 | 值 |
|---|---|
| 版本 | v2.15.5（2026-11-12 发布，GitHub API 实时取得） |
| 包 | `harbor-offline-installer-v2.15.5.tgz` |
| 大小 | 783,838,458 字节（748 MB） |
| sha256 | `18f9d4c47ad603743591e814b6c32136532ba7670132a94f4d9661f0fe46882c` |

### 下载

GitHub API 与 release 资产在本网络可达，但**单流直连 `release-assets.githubusercontent.com`
只有约 12 KB/s**（748 MB 要 17 小时）。实测最快的是 GitHub 代理 `ghfast.top`（约 505 KB/s）。

`scripts/download_harbor.py` 用 **8 MiB 小块 + 断点续传 + 快速轮换源**：

```bash
python3 scripts/download_harbor.py /tmp/harbor-offline-installer.tgz v2.15.5 --workers 8 --chunk-mib 8
```

- 源优先级：`ghfast.top` → `gh-proxy.com` → GitHub 直连
- 单次尝试上限 120 秒，慢源的代价被限制在 120 秒内
  （**用大分段时实测掉速到 8 MB/几分钟** —— 一旦落在慢源上要等整段超时才换源）
- 已下载的块会缓存，中断后重跑即续传
- 拼接后校验**大小 + sha256**，sha256 直接取自 GitHub API 的 `digest` 字段，不手抄

---

## 四、部署形态：并入重型栈

Harbor 是方案原版重型组件，因此遵循本项目重型栈的既有约定：

| 约定 | 本项目重型栈 | Harbor |
|---|---|---|
| 容器名前缀 | `eapheavy-` | `eapheavy-harbor-core` / `-db` / `-registry` / …（9 个） |
| 网络前缀 | `eapheavy_` | `eapheavy_harbor`（独立网络，与其它组件隔离） |
| 宿主端口 | 整体右移（8082/8094/9002…） | **8098** |
| 暴露面 | 只绑 `127.0.0.1` | 只绑 `127.0.0.1` |

改造由 `scripts/prepare_harbor.py` 完成 —— 它把官方生成的 `docker-compose.yml`
做**标识与暴露面**层面的改造，**不动 Harbor 自身的服务拓扑与内部配置**
（env 变量、依赖关系、健康检查、内部网络一律保留官方原样）：

1. 容器名统一 `eapheavy-harbor-<name>`（官方名字不统一：`harbor-log` / `registry` / `redis` / `nginx` 混用）
2. 端口 `8098:8080` → `127.0.0.1:8098:8080`
3. 网络 `harbor` → `eapheavy_harbor`

官方 compose 里的数据卷是 bind mount（指向 `data_volume`），不是命名卷，所以无需改名。

### hostname 为什么是 harbor.eap.local

Harbor 的 prepare **硬性拒绝**把 `127.0.0.1` 当 hostname
（源码 `utils/configs.py`：`if conf.get('hostname') == '127.0.0.1': raise`）。
解法是本机别名（`scripts/setup-harbor-hosts.sh`）：

```
127.0.0.1 harbor.eap.local
```

别名解析到 127.0.0.1，落在 Docker daemon 的默认 insecure registries 段
（`docker info` 实测：`::1/128` + `127.0.0.0/8`），所以 **HTTP 推送不需要改
daemon 配置、不需要重启 dockerd**。容器侧不依赖这个域名
（compose 模板里没有 extra_hosts，nginx 按 upstream 名 `core`/`registry` 转发）。

### 为什么走 HTTP 而不是 HTTPS

Harbor 默认是 HTTPS（自带自签证书）。本项目采用 **HTTP + 127.0.0.1**：
Docker 默认 insecure registries 已覆盖回环，HTTPS 则要把 CA 装到
`/etc/docker/certs.d/` 并改 harbor.yml 的证书路径，链路更长。
Harbor 暴露在回环地址、仅本机可达，风险由「不出本机」兜住。
生产部署到内网域名时应改回 HTTPS（见第六节）。

---

## 五、验收

Harbor 是**镜像仓**，验收不能只看「容器在跑」，必须**真实推拉一次**：

```bash
./scripts/verify-harbor.sh      # 21 项
```

| 项 | 结果 |
|---|---|
| 9 个组件容器 | ✅ core / db / jobservice / registry / registryctl / portal / log / redis / nginx 全部 healthy |
| 健康端点 | ✅ `GET /api/v2.0/health` → `status: healthy`（7 个组件逐项 healthy） |
| 版本 | ✅ `v2.15.5-8c17ef6e` |
| 管理员登录 | ✅ `admin` 接口 200，`sysadmin_flag=True` |
| 建项目 | ✅ `POST /api/v2.0/projects` → 201，项目 `eap` 可见 |
| **真实推送** | ✅ `docker push harbor.eap.local:8098/eap/alpine_3.20` |
| **真实拉回** | ✅ 删本地 → `docker pull` 从 Harbor 拉回，**层指纹与原镜像一致**（`63719798f4e63d479aafe46551f806ae`） |
| 仓库清单 | ✅ 项目 `eap` 下有镜像仓库 |

`scripts/verify-heavy.sh` 里另有一段轻量 Harbor 检查（容器/健康/版本/登录/仓库清单/端口收口），
不做推送拉回，避免每次回归都产生镜像写入。

---

## 六、三个实测坑

### 1. prepare 以 root 生成配置、容器以 uid 10000/999 运行

直接跑会 `permission denied`：`common/config/core/env` 是 `-rw-r----- root root`，
而 core 容器以 uid 10000 运行、db/redis 以 999 运行、宿主操作账号是 `root`。

必须做的三件事（`scripts/start-harbor.sh` 已包含）：

```bash
chmod -R o+rX common                        # 宿主用户与容器都能读
chown -R 10000:10000 data/{registry,job_logs,ca_download,secret}
chown -R 999:999    data/{database,redis}
mkdir -p /var/log/harbor && chmod 755 /var/log/harbor   # harbor-log 以 root 运行
```

### 2. 不能用 image ID 判断镜像一致性

本机 Docker 启用了 **containerd 镜像存储**（`driver-type: io.containerd.snapshotter.v1`），
`docker images` 的 ID 是 **manifest digest**；而 Harbor 的 registry v2 会把推上来的
OCI manifest 转成 Docker v2 schema2，**manifest digest 必然变化** ——
但镜像内容（层）是一模一样的。

所以校验要比 **RootFS 层指纹**：

```bash
docker image inspect <img> --format '{{range .RootFS.Layers}}{{.}}{{"\n"}}{{end}}' | sha256sum
```

### 3. 推送前必须先 docker login

Harbor 项目默认私有，匿名推送必然 `authorization failed: no basic auth credentials`。

```bash
printf '%s' "$HARBOR_PASS" | docker login harbor.eap.local:8098 -u admin --password-stdin
```

---

## 七、生产落地

1. **HTTPS**：生产必须启用 HTTPS 并把 Harbor 签发/使用的 CA 下发到所有客户端的信任库。
2. **口令**：默认管理员 `admin / Harbor12345` **必须在首次登录后立即修改**；
   数据库口令（`database.password`）、Redis 口令同样要替换。
3. **域名**：`harbor.yml` 的 `hostname` 与 `external_url` 要改成内网域名，
   否则推送的镜像引用会指向 `harbor.eap.local:8098`，其他机器无法拉。
4. **平台镜像入库**：本项目自身镜像的推送脚本见 `deploy/compose/README.md`。
5. **容量**：Harbor 会占用约 2–3 GB 磁盘（镜像库）+ PostgreSQL 数据卷，
   生产需单独规划存储并纳入备份（Harbor 自带 `pg_dump` 备份工具）。
