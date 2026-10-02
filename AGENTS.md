# AGENTS.md —— dsh-audio-cue

## 包结构

```
lib/index.js        宿主半：四条事件源 + 带回退的 spawn 播放（v0.1.3 正式版，约 260 行）
assets/approval.wav 审批提示音
assets/turn-end.wav 回合结束提示音
cordis.patch.yml    bundle patch：一条 insert（七个配置键）
package.json        dsh.bundle.patch 指向上面那份
scripts/smoke.mjs   离线冒烟自检：node scripts/smoke.mjs（断言 waterfall 都放行了 next）
```

## 改这个插件时要守住的三条

1. **`stdio` 只能 `"ignore"`**。沙箱内捕获子进程 stdio 会 `EPERM`；改它会让整个播放静默失败。
2. **播放路径必须包在 `try/catch` 里，并挂 `child.on("error")`**。失败模式必须是"没响"，绝不能是"会话出错"；但**成功路径也要写日志**（见第四条）。
3. **不要给它加 `inject`**。它只订阅事件，不依赖任何服务；一旦声明了 `inject`，服务未就绪就会推迟装载，白白丢掉早期事件。

## 🔴 第四条：不要订阅 waterfall 事件去"顺便放个声音"

cordis 的 waterfall（`ctx.waterfall(...)`）语义是「listener 最外层先跑；**不调用 `next()` 即否决整条链，含内置行为**」（`cordis/lib/index.js:311-325`）。观察者一旦忘了 `next()`，不是"少响一声"，而是**把整条链掐死**：

```
dsh-user-approval:176   ctx.waterfall(…, "approval/request", req, () => Promise.resolve("unavailable"))
                        ↓ 观察者不调 next() ⇒ 返回 undefined
                        ↓ OUTCOMES 归一化 ⇒ "unavailable"
dsh-sandbox:120         throw new Error('sandbox escalation to "…" requires approval, but no approval channel is available')
```

后果：提权被拒、审批面板永不出现、整条 GUI 审批通道形同虚设——**而插件日志里一行报错都没有**（v0.1.0 就是这样把 0.2.0-rc.2 打瘫的）。

**规矩**：要响在某个动作上，先找 **`emit` / `serial` 派发的事件**；非要订阅 waterfall（`approval/request`、`tools/execute`），**必须接 `next` 并原样放行**。判据：在 `versions/<ver>/node_modules/.pnpm` 下 grep `\.waterfall(` 与该事件名；首参是对象/函数的事件会走 scope filter。

## 🔴 第五条：日志必须覆盖成功路径，否则诊断会翻车

v0.1.1 只在失败路径写日志 → 排查时把「`play()` 从未被调用」当成了定论，而真相可能是"被调用了、播放器也起来了、就是没出声"。**任何"没发生"的结论，都必须先有一条"发生了就会打印"的成功日志兜底。**

本插件的日志基线（缺一不可）：

| 时机 | 必须打 |
|---|---|
| 事件送达 | `event <事件名> fired` |
| 播放入口 | `play >> <来源>`（v0.1.3 起不再带 pid；pid 只在失败排查时才需要） |
| 子进程结束 | `player exit=<code> (<player>)` |
| 失败 | `spawn failed …` / `play threw …` / `asset missing …` |
| 装载 | `vX.Y.Z 已加载…` + `players=[…] | assets: …` |

## 会话事件（日志类型）与总线事件的区别

`approval/asked`、`turn/end`、`approval/decided` 是 **`session.append` 写进会话日志的记录类型**，不是总线事件 —— `ctx.on("turn/end")` 永远收不到。要拿它们只能订阅 `session/event` 后看 `event.type`（**实测可达**：日志 `event session/event turn/end`）。

真总线事件对照：回合结束 = `agent/turn-stopping`（`dsh-agent-loop/index.js:999`，**serial、首参字符串 ⇒ 无 scope 过滤**），审批 = `approval/request`（**waterfall，别忘 next()**）。

## 实测基线（2026-10-02，0.2.0-rc.2）

| 项 | 结论 |
|---|---|
| 宿主播放链路 | `pwsh 7` 绝对路径 + **不带 `detached`** + `stdio:"ignore"` ⇒ `exit=0` 且**出声**（两处同时改，未做单变量对照） |
| `approval/request` | 可达（waterfall，**放行 next()** 后不再截断审批） |
| `session/event` | **可达**（`event session/event turn/end` 有日志）—— 曾推测"insert 装载会被 scope 挡"，**已被证伪**：全机第三方插件用的是同一种 `- insert:` 挂载 |
| `agent/turn-stopping` | 可达（serial，无 scope 过滤），但 payload 无 agent 信息、判不了子代理 |
| `turn/end` / `approval/asked` | **只是日志记录类型**，`ctx.on()` 收不到 |

## 跨版本

事件名 `approval/request`、`tools/execute`、`session/event` 在三代（0.1.5-rc.3 / 0.1.7-rc.2 / 0.2.0-rc.2）内核里都存在；`agent/turn-stopping` 在 0.2.0-rc.2 已核实，换版本时先 grep 一次。现在有四条源互为备份：改完务必跑 `node scripts/smoke.mjs` + 看一次实例日志里有没有 `play >> …`。装法有差异：`0.1.7-rc.2` / `0.2.0-rc.2` 要带 `--config.store-dir`，`0.1.5-rc.3` 不要。`dsh.compatibility.runtime` 声明 `>=0.1.1-rc.1 <0.3.0`。

## 换素材

直接覆盖 `assets/` 下的同名文件，**重启实例**生效。素材来源 URL 与音色写在 `README.md` 里；重新拉取用 `Invoke-WebRequest` 会因 PS 5.1 的 TLS 问题报 `Authentication failed`，**用 Node 的 `fetch` 或 `curl.exe`**。

## 退路

宿主播放若被证伪（自检音无声但日志有 `play >> …`），改走**客户端播放**：宿主起 HTTP 路由供 WAV 字节，客户端 `AudioContext` 播放 —— 样本是 `dsh-whale-widget`（`/dsh-whale/audio-fragment.wav`）。
