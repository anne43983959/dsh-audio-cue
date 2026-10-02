# dsh-audio-cue

> **DSH**（DeepSeek Harness）宿主插件：**审批询问**与**一轮对话结束**时播放声音提示。
> 纯宿主半、零外部依赖；不注册工具、不注册服务、不碰任何现有文件。

```powershell
# 从 GitHub 安装（0.2.x / 0.1.7 线需要 --config.store-dir，见下方说明）
dsh plugin --profile web add github:anne43983959/dsh-audio-cue
```

装完**重启对应实例**生效 —— 宿主模块与客户端 bundle 都在启动时装载。

---

## 它监听什么

| # | 事件 | 派发方式 | 作用 |
|---|---|---|---|
| ① | `approval/request` | **waterfall** | 审批询问音 —— **订阅者必须放行 `next()`**，否则会否决整条审批链 |
| ② | `session/event` → `event.type === "turn/end"` | `emit` | 回合结束**主路径**（拿得到 `session`，可挡掉子代理收工那一声） |
| ③ | `agent/turn-stopping` | `serial` | 回合结束**兜底**：延迟 2 s，且只在主路径没送来 `turn/end` 时才出声 |
| ④ | `tools/execute` → `ask_user_question` | **waterfall** | 提问音 —— 同样必须放行 `next()` |

**为什么回合结束要挂两条**：② 能按 `session.header.origin === "subagent"` 过滤子代理，但走 scope carrier；③ 首参是字符串所以没有 scope 过滤、必然可达，却拿不到 agent 身份。于是 ② 当主路径、③ 当兜底 —— 兜底先看"这段时间主路径有没有送来 `turn/end`"，送到了就不出声。

---

## 这份代码里有两次实测事故，改之前请先读

### 事故一：watcher 弄死了审批链（v0.1.0）

`approval/request` 是 cordis 的 **waterfall** 事件：

```js
// dsh-user-approval/lib/index.js:176
ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))
```

而 waterfall 的语义是「listener 最外层先跑；**不调用 `next()` 即否决整条链，含内置行为**」（`cordis/lib/index.js:311-325`）。初版的 listener 签名只有 `(payload)`，`next` 被丢掉、返回 `undefined`，于是：

```
观察者不调 next() ⇒ 返回 undefined
   ⇒ OUTCOMES 归一化成 "unavailable"
   ⇒ dsh-sandbox 抛 "sandbox escalation requires approval, but no approval channel is available"
```

**后果**：提权被拒、审批面板永不出现、整条 GUI 审批通道形同虚设 —— 而插件日志里一行错都没有。
**实测**：本插件在册时两次提权 `outcome=unavailable`；摘除后同样的调用立刻 `allowed-once` ×2。

> 同一个文件里 `turn/end` 与 `approval/asked` 也挂错了 —— 它们是 `session.append` 的**日志记录类型**，不是总线事件，`ctx.on("turn/end")` 永远收不到。

### 事故二：从来就没响过（v0.1.0 → v0.1.2）

初版 `play()` 用 `detached: true` + `powershell` 5.1 在宿主进程里 spawn 播放。**它确实被调用过**（否则不会截断审批瀑布），但**从未出过声**，而且失败被 `try/catch` 吞干净。

v0.1.1 试图修事件源，却只写了失败路径的日志 —— 结果下一轮排查把"没有失败日志"误读成"`play()` 从未被调用"，白白多绕一轮。

**v0.1.2 同时改两处后出声**：去掉 `detached`、播放器换成 `pwsh` 7 绝对路径（失败自动回退 `powershell` 5.1），并**把成功路径也写进日志**。
⚠️ 两处是同时改的，没做单变量对照；任何一处改回去都要重测。

完整时间线见 [CHANGELOG.md](CHANGELOG.md)。

---

## 配置

配置写在 profile 的 bundle patch 层（本插件自带的 `cordis.patch.yml`，或 profile 的 `cordis.patch.yml` 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `approval` | `true` | 审批询问响 |
| `ask` | `true` | 提问（`ask_user_question`）响，与审批同一声 |
| `turnEnd` | `true` | 一轮结束响 |
| `ignoreSubagents` | `true` | 子代理会话的回合结束不响 |
| `fallbackTurnStopping` | `true` | 回合结束兜底路径开关 |
| `fallbackDelayMs` | `2000` | 兜底延迟（毫秒） |
| `selfTest` | `false` | 自检音：装载后自动播一声，仅用于排查"宿主进程能不能出声" |
| `selfTestMs` | `2500` | 自检音延迟（毫秒） |

## 怎么读日志

实例日志里所有行都以 `[dsh-audio-cue]` 开头：

| 日志行 | 含义 |
|---|---|
| `v0.1.3 已加载…` + `players=[…] | assets: approval=true turnEnd=true` | 插件在册、播放器与素材就位 |
| `play >> session/event:turn/end` | 回合结束声已触发（正常每轮一行） |
| `play >> approval/request` | 审批声已触发 |
| `spawn failed (…): <原因>` | 播放器起不来（ENOENT / EPERM …） |
| `player exit=<非0>` / `fallback -> …` | 第一个播放器失败，已自动换另一个 |
| `subagent turn/end skipped` | 子代理会话被挡掉（正常） |
| `turn-stopping fallback skipped（…）` | 主路径活着，兜底按设计让位（正常） |
| `event agent/turn-stopping → 兜底出声` | 主路径不可达，兜底补了一声 |

## 安装（三种方式）

```powershell
# ① GitHub（推荐）
dsh plugin --profile web add github:anne43983959/dsh-audio-cue

# ② 本地源码（开发用）
dsh plugin --profile web add link:<本仓库绝对路径>

# ③ 0.1.7 线 / 0.2.x 若报 ERR_PNPM_UNEXPECTED_STORE
#    带上该 profile 的 pnpm store 目录（值取 node_modules\.modules.yaml 的 storeDir）
dsh plugin --profile web add github:anne43983959/dsh-audio-cue --config.store-dir="<storeDir>"
```

**注意 `--profile` 必须写在 `plugin` 之后。** 卸载 / 回滚：`dsh plugin --profile web remove dsh-audio-cue`。

## 自检

```powershell
node scripts/smoke.mjs
```

离线跑，**不出声**：断言四条事件源都在位，且每一处 waterfall 订阅都放行了 `next()`。改完代码务必跑一次。

## 素材

| 用途 | 文件 | 大小 | 音色 |
|---|---|---:|---|
| 审批 | `assets/approval.wav` | 418,322 B | `clean UI confirmation chime`（2.37 s） |
| 回合结束 | `assets/turn-end.wav` | 302,250 B | `glassy bright crisp short ascending` |

两段均为 44.1 kHz / 16-bit / 立体声 WAV，取自 BudgetPixel 免费音效库（原始 URL 见 git 历史）。**换素材只需替换 `assets/` 下的同名文件**，重启实例生效。

## 兼容

- `dsh.compatibility.runtime`: `>=0.1.1-rc.1 <0.3.0`
- 用到的四个事件名在 DSH `0.1.5` / `0.1.7` / `0.2.0` 三代内核里都存在（`agent/turn-stopping` 在 `0.2.0-rc.2` 上核实过；换版本请先 grep 一次再信任）。
- 纯宿主半，没有客户端 bundle —— 不受客户端模块 id / 座位契约变化影响。

## License

[MIT](LICENSE)
