# MCode TUI「自动粘底」的关闭方法

本机跑 MCode CLI（`@minimax-ai/code` 0.7.7）时，往上翻历史会被新输出立刻拽回底部。
本文说明根因、补丁与取舍。

---

## 一、现象

在 regular 渲染模式下：

1. 往回滚动查看上方的历史输出
2. 此时若有新输出到达（模型回复、工具结果、后台任务通知……）
3. 视口立刻跳回底部，输入框重新占据视野

---

## 二、根因（源码级，已定位）

MCode 的 regular 渲染器里，「**是否跟随底部**」不是按用户视口位置判断的，而是：

```js
// chunks/launcher-*.js —— regular 渲染器
hostFollowsBottom(){
  return this.forceHistoryReplay
      || performance.now() - this.lastUserInputAt <= b_;   // b_ = 1000ms
}
```

也就是说：**只要最近 1 秒内有键盘输入，就判定为「跟随底部」。**

鼠标滚轮在 regular 模式下由终端原生 scrollback 处理，程序看不见滚轮事件，
所以「一边打字一边往上翻历史」时，每来一条新输出都会被判定为跟随 → 视口被拽回底部。

Fullscreen 模式没有这个问题：它用 `ScrollView.isFollowingEnd` 精确跟踪视口，
滚上去后就不再跟随：

```js
// chunks/launcher-*.js —— TuiChatLayout
followBottom(){ this.fullscreenBodyViewport.isFollowingEnd && this.fullscreenBodyViewport.scrollToEnd() }
```

> 官方设计文档
> [`docs/superpowers/specs/2026-09-23-tui-follow-tail-design.md`](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/superpowers/specs/2026-09-23-tui-follow-tail-design.md)
> 明确写了 **Non-goals: Do not add a `followTail` configuration setting** ——
> 即官方**刻意没有提供**这个开关。本项目的补丁就是补上它。

---

## 三、补丁

`scripts/patch-mcode-follow-tail.sh` 改写上面那个判定，改为额外读一个环境变量：

```js
hostFollowsBottom(){
  return this.forceHistoryReplay
      || (process.env.MCODE_NO_FOLLOW_TAIL === "1"
            ? false
            : performance.now() - this.lastUserInputAt <= b_);
}
```

```bash
./scripts/patch-mcode-follow-tail.sh            # 打补丁（幂等）
./scripts/patch-mcode-follow-tail.sh --status   # 查看状态
./scripts/patch-mcode-follow-tail.sh --revert   # 还原
```

脚本的行为约定：

- **按内容定位目标文件**，不依赖文件名（chunk 文件名带内容 hash，`mcode update` 后会变）
- **恰好 1 处匹配才改**，匹配数不对就拒绝修改，避免改坏客户端
- 改前自动备份到 `<chunk>.eap-follow-tail.bak`
- 改完跑 `node --check` 语法校验，失败自动还原
- 找不到目标表达式就**退出 1**，不做模糊替换

---

## 四、使用

补丁只改判定逻辑，**实际开关由环境变量控制**——改一次包，以后随便开/关：

```bash
SESSION_ID=mvs_6eb432c8   # 示例，替换为实际 session id
MCODE_NO_FOLLOW_TAIL=1 mcode                            # 单次
MCODE_NO_FOLLOW_TAIL=1 mcode --session "$SESSION_ID"    # 继续指定会话
```

已安装一个不覆盖 `mcode` 的并列入口（两个命令并存，随时切回官方行为）：

```bash
mcode-nofollow              # 新会话
mcode-nofollow --continue   # 继续最近的会话
```

> **推荐用 `mcode-eap`**（见第六节）—— 它在 `mcode-nofollow` 基础上多做了
> 「root 直接进，不用切用户」和「`--tui-mode regular` 保证终端原生选区/右键粘贴可用」。

> **需要重启 mcode 才生效** —— 当前进程已经加载了旧代码。

---

## 五、取舍

关闭后的行为：

| 场景 | 行为 |
|---|---|
| 往上翻历史 | ✅ **不再被新输出拽回**（这就是本次要的） |
| 停在底部等模型回复 | ⚠️ 新内容**不再自动滚入视野**，需要自己按 `End` 或滚到底部 |
| 提交新消息 | ✅ 仍会强制回到底部（这是「用户主动意图」，官方刻意保留） |
| 切换 / 新建会话 | ✅ 仍会强制回到底部（同上） |

也就是说：被关掉的是「**别人替我决定滚到底**」，保留的是「**我自己决定滚到底**」。

如果觉得「等回复时不自动滚动」不可接受，两个替代方案：

1. **用 fullscreen 模式** —— 官方原生支持，视口跟随判定是精确的：
   ```bash
   mcode --tui-mode fullscreen
   ```
   滚上去能保持位置，同时在底部时仍会自动跟随新输出。
   **代价：鼠标与剪贴板被应用接管**（详见第八节）—— 终端原生拖拽选区与右键粘贴失效，
   复制要改用 TUI 自带选区（拖选 → 自动复制，或 Ctrl+C = "Copy selection"）。
2. **不设 `MCODE_NO_FOLLOW_TAIL`** —— 保持官方行为（补丁在，但开关关着）。

---

## 六、一条命令进指定会话（`mcode-eap`）

`scripts/mcode-eap.sh`（安装到 `/usr/local/bin/mcode-eap`）把三件事一次做完：

1. **root 直接进，不用切用户** —— MCode CLI 直接以 root 启动（`HOME=/root`，
   进程属主就是 root），运行时数据目录通过 `MINIMAX_DATA_DIR` 显式指定，
   因此既不需要 su，也不需要 sudo；
2. **`--tui-mode regular`** —— 终端原生 scrollback + 拖拽选区 + 右键粘贴；
3. **`MCODE_NO_FOLLOW_TAIL=1`** —— 关掉自动粘底。

**关于运行时数据目录**：会话可能分散在多个 MCode 运行时目录里
（`/root/.minimax` 与既有实例目录），脚本会在确定目标 session 后
**收敛到真正含该 session 的那个目录** —— 指向错的目录，MCode CLI 会报「会话不存在」。

> ⚠ 会话目录名里放的是 **base64 编码后的** session id，不是原始 id：
> `mvs_6eb432c8…` → `13-57-10-293-session_bXZzXzZlYjQzMmM4MDU4NDQzZDQ4NDYwYzg0YWU0YTEzNTJk`。
> 匹配会话必须按编码后的名字找，直接拿原始 id 去 glob 是找不到的。

`--dry-run` 可放在任意参数位置（`mcode-eap "$SESSION_ID" --dry-run` 也能正确打印）。

```bash
SESSION_ID=mvs_6eb432c8          # 示例，替换为实际 session id
mcode-eap                        # 进入默认 session
mcode-eap "$SESSION_ID"          # 进入指定 session
mcode-eap --continue             # 继续最近一次会话
mcode-eap --list                 # 列出本机 session（mvs_ id + 时间 + 首条用户消息）
mcode-eap --dry-run              # 只打印将要执行的命令，不启动
```

安装 / 升级：

```bash
sudo ./scripts/install-mcode-eap.sh        # 安装到 /usr/local/bin/mcode-eap
```

脚本会**自检补丁是否在位**，缺失直接报错退出并提示补打，不会让你误以为「不自动滚屏」已生效。

---

## 七、渲染模式与鼠标/剪贴板（实测）

MCode 0.7.7 有两种渲染器（`chunks/launcher-*.js`）：

| | `Bs`（regular） | `Ca`（fullscreen） |
|---|---|---|
| 官方说明 | Uses terminal scrollback, selection, and copy. | Keeps MCode in a fixed viewport with in-app scrolling. |
| 进备用屏 `1049h` | ❌ | ✅ |
| 鼠标追踪 `1000h/1002h/1003h/1006h` | ❌ | ✅ |
| 自带选区 `applySelection` | ❌ | ✅ |

源码依据：写 `1049h` + `1000h/1002h/1003h/1004h/1006h` 的 `beforeTerminalStart()`
**只在 `Ca` 上**；`Bs` 没有这段。且 `this.mouseEnabled = s.mouse ?? !0`，
而全包里 `mouse:` 从未被传入 → 恒为 true（fullscreen 下鼠标必被接管）。

**伪终端实测**（`scripts/verify-tui-mode-escapes.py`，捕获 MCode 实际写出的字节）：

```
=== --tui-mode regular ===
  ❌ 未发现 1049h 进备用屏        ❌ 未发现 1000h/1002h/1003h/1006h 鼠标追踪
  ✅ 发现   2004h bracketed paste
  → ✅ 终端原生选区/右键粘贴可用

=== --tui-mode fullscreen ===
  ✅ 发现 1049h 进备用屏        ✅ 发现 1000h/1002h/1003h/1006h 鼠标追踪
  → ⚠ 鼠标被应用接管，需用 TUI 自带选区
```

### 复制/粘贴在 fullscreen 下怎么用

- **复制**：鼠标拖动选中 → `copyOnSelect` 默认开启，松手即自动复制（走 OSC 52）；
  或拖动后按 **Ctrl+C**（键位 `tui.input.copy` = "Copy selection"）。
  **Enter** = 确认选区，**Esc** = 取消。
  ⚠️ **Ctrl+C 在 MCode 里被改成「复制选区」，不再是终端的 SIGINT**。
  ⚠️ 若提示 "Copied!" 但剪贴板没变 → 终端屏蔽了 OSC 52，需在终端设置里放开
  （iTerm2：Profiles → General → "Allow clipboard access"；tmux：`set -g set-clipboard on`）。
- **粘贴**：MCode **没有 `tui.input.paste` 键位**，靠终端的 bracketed paste（`2004h`），
  所以要用**终端自己的快捷键**：Linux xterm/gnome-terminal/Windows Terminal = **Ctrl+Shift+V**，
  macOS Terminal/iTerm2 = **Cmd+V**，X11 = 中键。
  ⚠️ **右键粘贴是 Windows 专属**（`handleRightClickPaste` 里判断
  `process.platform !== "win32"` 就返回 false），Linux 上右键不会粘。

---

## 八、升级注意事项

`mcode update` 会覆盖安装目录，**补丁会失效**。升级后重新执行：

```bash
mcode update && ./scripts/patch-mcode-follow-tail.sh
```

`mcode-nofollow` 入口会自检补丁是否在位，缺失时直接报错退出并提示补打，
不会让你误以为开关已经生效。

---

## 九、来源

- 官方仓库：[MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)
- Follow-tail 设计文档：[`2026-09-23-tui-follow-tail-design.md`](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/superpowers/specs/2026-09-23-tui-follow-tail-design.md)
- TUI 能力说明：[`docs/tui-capabilities.md`](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/tui-capabilities.md)
- 官方 CLI 配置文档（确认 `config.yaml` 无滚动相关项）：https://agent.minimaxi.com/docs/cli/configuration.md
