# Changelog

本插件的每一次行为变化都来自实测，不是设计推演。下面把踩过的两次坑原样记下来 —— 改这个插件之前请先读 v0.1.0 与 v0.1.1 两节。

## v0.1.3 — 正式版

- **自检音默认关闭**（`selfTest: false`）。它只在排查「宿主进程能不能出声」时临时打开。
- **回合结束音改为「主路径 + 兜底」**：
  - 主路径 `session/event` → `turn/end`：拿得到 `session`，可按 `header.origin === "subagent"` 把子代理收工那一声挡掉；
  - 兜底 `agent/turn-stopping`：延迟 `fallbackDelayMs`（默认 2 s），且只在"这期间主路径没送来过 `turn/end`"时才出声。
  - 修掉上一版"兜底抢响"的副作用 —— v0.1.2 里是 turn-stopping 先到先响，用子代理的那一轮会多响一声。
- 日志精简：正常路径只留 `play >> <来源>`，去掉 pid 与去重噪音。
- 新增配置键 `fallbackTurnStopping` / `fallbackDelayMs`。

## v0.1.2 — 第一次听到声音

- **修好播放链路**（这是"从来就没响过"的真正原因）：
  - 去掉 `spawn` 的 `detached: true`；
  - 播放器改为 **`pwsh` 7 绝对路径优先**，失败自动回退 `powershell` 5.1；
  - 成功路径也写日志。
  > 两处是同时改的，没有做单变量对照；任何一处改回去都要重测。
- **事件源扩到四条**，互为备份：`approval/request`（放行 `next()`）、`session/event`、`agent/turn-stopping`、`tools/execute`（放行 `next()`）。
- 新增自检音 `selfTest`：装载后自动播一声，专门验证"宿主进程能不能出声"，与事件可达性无关。

## v0.1.1 — 修错方向的中间版

- 把事件源从 `approval/request` / `approval/asked` / `turn/end` 换成 `session/event`。
- **只在失败路径写日志** —— 这个决定让下一轮排查把"没有失败日志"误读成"`play()` 从未被调用"。**教训：任何"没发生"的结论，都必须先有一条"发生了就会打印"的成功日志兜底。**
- 仍然没有声音（播放链路的问题没被发现）。

## v0.1.0 — 初版，两个隐患同时埋下

- **隐患 A（事件面）**：
  - `approval/request` 是 cordis **waterfall** 事件，初版订阅了它却**不调用 `next()`**。waterfall 的语义是「listener 最外层先跑；不调 `next()` 即否决整条链，含内置行为」（`cordis/lib/index.js:311-325`）。结果：浏览器端审批应答者被挡在链外，返回值 `undefined` 被归一化成 `"unavailable"` ⇒ **提权被拒 + 审批面板永不出现**。实测：本插件在册时两次提权 `outcome=unavailable`；摘除后同样调用 `allowed-once` ×2。
  - `turn/end` 与 `approval/asked` 是 `session.append` 的**日志记录类型**，不是总线事件 ⇒ `ctx.on("turn/end")` 永远收不到，那两声从装上起就没响过。
- **隐患 B（播放链路）**：`detached: true` + `powershell` 5.1 的组合在宿主进程里不出声，且失败被 `try/catch` 全吞 —— 用户从未听到过任何声音。
