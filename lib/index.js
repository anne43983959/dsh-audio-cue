/**
 * dsh-audio-cue —— 审批询问与回合结束的声音提示（宿主半，正式版）。
 *
 * 纯宿主半、零外部依赖。播放失败绝不影响会话（全程 try/catch，失败只写日志）。
 *
 * ═══ 事件面：全部经 2026-10-02 实测确认 ══════════════════════════════════
 *
 * ① approval/request（审批音主路径）
 *    cordis **waterfall**：dsh-user-approval/lib/index.js:176
 *      ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))
 *    ⇒ **必须放行 next()**：waterfall 的语义是「不调 next() 即否决整条链，含内置行为」
 *      （cordis lib/index.js:311-325）。v0.1.0 漏了这一步，浏览器端审批应答者被挡在链外，
 *      返回 undefined 被归一化成 "unavailable" ⇒ 提权被拒 + 审批面板永不出现。
 *
 * ② session/event → event.type === "turn/end"（回合结束**主路径**，可过滤子代理）
 *    emit 派发，实测**可达**（2026-10-02 日志 `event session/event turn/end`）。
 *    ⚠️ `turn/end` / `approval/asked` 是 session.append 的**日志记录类型**，
 *    直接 ctx.on("turn/end") 永远收不到 —— v0.1.0 就是这么哑掉的。
 *
 * ③ agent/turn-stopping（回合结束**兜底**，延迟 2 s 且仅在 ② 未送达时才响）
 *    dsh-agent-loop/lib/index.js:999 `await this.dispatch.serial("agent/turn-stopping", { turn, signal })`
 *    首参是字符串 ⇒ dispatch 的 thisArg 为 null ⇒ **无 scope 过滤**，所有监听者一律接纳；
 *    实测可达（日志 `event agent/turn-stopping fired`）。但它的 payload 只有 {turn, signal}，
 *    **判不出子代理** —— 所以让它当兜底，不要让它抢主路径，否则子代理收工也跟着响。
 *
 * ④ tools/execute → ask_user_question（提问音）
 *    同样是 waterfall ⇒ 必须放行 next()。
 *
 * ═══ 播放链路（v0.1.2 修好，实测 exit=0 且出声）═══════════════════════════
 *  宿主进程里出过声的组合：**pwsh 7 绝对路径** + **不带 detached** + stdio "ignore" + windowsHide。
 *  两处是同时改的（去掉 detached / 换成 pwsh 7），没做单变量对照；任何一处改回去都要重测。
 *  播放器按 [pwsh7, powershell5.1] 顺序尝试，失败（error / exit≠0）自动回退。
 *
 * ═══ 日志纪律（v0.1.1 的教训）═════════════════════════════════════════════
 *  成功路径也必须打日志，否则「没触发」与「播不出来」永远分不清。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Stable cordis plugin name. */
export const name = "dsh-audio-cue";

/** 只订阅事件、不注册服务与工具，因此什么都不需要注入。 */
export const inject = [];

const VERSION = "0.1.3";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = {
	approval: join(ROOT, "assets", "approval.wav"),
	turnEnd: join(ROOT, "assets", "turn-end.wav"),
};

/** 播放器候选：pwsh 7 优先（实测出声的那个），再退 PS 5.1，最后退裸名。 */
const PS7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const PS5 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PLAYERS = [PS7, PS5].filter((p) => existsSync(p));
if (PLAYERS.length === 0) PLAYERS.push("powershell");

/** 正在播放的句柄：连响时先掐掉上一声，避免叠音。 */
let playing = null;

/** 去重表：同一类声音在窗口期内只播一次（多路事件源可能命中同一时刻）。 */
const lastPlayed = new Map();

/** 最近一次「看到 turn/end 日志事件」的时刻 —— 兜底路径靠它判断主路径是否已经送到。 */
let lastTurnEndSeen = 0;

/** 诊断日志：写进实例日志；自己绝不抛错。 */
function log(msg) {
	try { console.log("[dsh-audio-cue] " + msg); } catch { /* ignore */ }
}

/**
 * 起一个播放进程。
 * Media.SoundPlayer 无窗口、不走文件关联。
 * ⚠️ 两条硬约束（都是实测换来的）：**不带 detached**、播放器用绝对路径。
 * ⚠️ stdio 保持 "ignore"：这条纪律来自工具进程沙箱（捕获子进程 stdio 会 EPERM），
 *    宿主进程里虽然不受限，但保持同一形态可以少一个变量。
 * @param player - 播放器可执行文件。
 * @param file - WAV 绝对路径。
 * @param onFail - 失败回调（用于回退到另一个播放器）。
 */
function spawnPlayer(player, file, onFail) {
	try {
		const child = spawn(
			player,
			["-NoProfile", "-NonInteractive", "-Command",
				"(New-Object Media.SoundPlayer '" + file.replace(/'/g, "''") + "').PlaySync()"],
			{ stdio: "ignore", windowsHide: true },
		);
		child.on("error", (e) => { log("spawn failed (" + player + "): " + e.message); if (onFail) onFail(); });
		child.on("exit", (code) => {
			if (code !== 0 && code !== null) {
				log("player exit=" + code + " (" + player + ")");
				if (onFail) onFail();
			}
		});
		return child;
	} catch (e) {
		log("spawn threw (" + player + "): " + e.message);
		if (onFail) onFail();
		return null;
	}
}

/**
 * 播放一段 WAV。
 * @param file - WAV 绝对路径。
 * @param label - 触发来源，写进日志用于分辨「哪条路响了」。
 */
function play(file, label) {
	try {
		if (!existsSync(file)) { log("asset missing: " + file); return; }
		if (playing !== null) {
			try { playing.kill(); } catch { /* 已经退出了 */ }
			playing = null;
		}
		let fellBack = false;
		const fallback = () => {
			if (fellBack) return;
			fellBack = true;
			const alt = PLAYERS.find((p) => p !== PLAYERS[0]);
			if (!alt) return;
			log("fallback -> " + alt);
			playing = spawnPlayer(alt, file, null);
		};
		playing = spawnPlayer(PLAYERS[0], file, fallback);
		log("play >> " + label);
	} catch (e) { log("play threw: " + e.message); }
}

/**
 * 带去重的播放：多路事件源可能在同一瞬间都命中。
 * @param kind - 声音类别（approval / turnEnd）。
 * @param file - WAV 路径。
 * @param label - 触发来源。
 * @param windowMs - 去重窗口。
 * @returns 是否真的播了。
 */
function playOnce(kind, file, label, windowMs) {
	try {
		const now = Date.now();
		const prev = lastPlayed.get(kind) ?? 0;
		if (now - prev < (windowMs ?? 1500)) return false;
		lastPlayed.set(kind, now);
		play(file, label);
		return true;
	} catch (e) { log("playOnce threw: " + e.message); return false; }
}

/**
 * 子代理会话判定：session header 带 origin:"subagent" 或 parentSession。
 * @param session - session/event 的第一个参数。
 */
function isSubagentSession(session) {
	try {
		const h = session?.header;
		return h?.origin === "subagent" || h?.parentSession !== undefined;
	} catch { return false; }
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
	const cfg = {
		enabled: config?.enabled !== false,
		/** 提问（agent 主动提问）也响，与审批同一声。 */
		ask: config?.ask !== false,
		approval: config?.approval !== false,
		turnEnd: config?.turnEnd !== false,
		ignoreSubagents: config?.ignoreSubagents !== false,
		/** 装载后自动播一声，用于验证宿主播放链路（正式版默认关）。 */
		selfTest: config?.selfTest === true,
		selfTestMs: Number(config?.selfTestMs ?? 2500),
		/** 兜底路径开关：session/event 那条主路径送不到时，用 agent/turn-stopping 补一声。 */
		fallbackTurnStopping: config?.fallbackTurnStopping !== false,
		fallbackDelayMs: Number(config?.fallbackDelayMs ?? 2000),
	};
	if (!cfg.enabled) return;

	// ① 审批音：approval/request（waterfall）—— **必须放行 next()**。
	if (cfg.approval) {
		ctx.effect(() => ctx.on("approval/request", (req, next) => {
			try {
				log("event approval/request fired");
				playOnce("approval", ASSETS.approval, "approval/request");
			} catch { /* 观察者失败绝不影响审批 */ }
			return typeof next === "function" ? next() : undefined;
		}), "dsh-audio-cue: approval/request");
	}

	// ② 回合结束主路径：session/event 的 turn/end（能拿 session，可过滤子代理）。
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		try {
			const type = event?.type;
			if (type === "approval/asked") {
				if (!cfg.approval) return;
				if (playOnce("approval", ASSETS.approval, "session/event:approval/asked")) log("event session/event approval/asked");
				return;
			}
			if (type === "turn/end") {
				lastTurnEndSeen = Date.now();
				if (!cfg.turnEnd) return;
				if (cfg.ignoreSubagents && isSubagentSession(session)) { log("subagent turn/end skipped"); return; }
				if (playOnce("turnEnd", ASSETS.turnEnd, "session/event:turn/end")) log("event session/event turn/end");
			}
		} catch { /* ignore */ }
	}), "dsh-audio-cue: session/event");

	// ③ 回合结束兜底：agent/turn-stopping（serial，无 scope 过滤）。
	//    延迟一拍再决定 —— 如果这段时间里 session/event 已经送来了 turn/end（哪怕被子代理过滤掉），
	//    就说明主路径活着，兜底不出声，免得子代理收工也响。
	if (cfg.turnEnd && cfg.fallbackTurnStopping) {
		ctx.effect(() => ctx.on("agent/turn-stopping", () => {
			try {
				const timer = setTimeout(() => {
					const seenAgo = Date.now() - lastTurnEndSeen;
					if (seenAgo < cfg.fallbackDelayMs + 500) {
						log("turn-stopping fallback skipped（session/event 已在 " + seenAgo + " ms 前送达 turn/end）");
						return;
					}
					if (playOnce("turnEnd", ASSETS.turnEnd, "agent/turn-stopping(fallback)")) log("event agent/turn-stopping → 兜底出声");
				}, cfg.fallbackDelayMs);
				if (typeof timer?.unref === "function") timer.unref();
			} catch { /* ignore */ }
		}), "dsh-audio-cue: agent/turn-stopping");
	}

	// ④ 提问音：tools/execute（waterfall）—— 必须放行 next()。
	if (cfg.ask) {
		ctx.effect(() => ctx.on("tools/execute", (exec, next) => {
			try {
				const tool = exec?.name ?? exec?.tool ?? "";
				if (tool === "ask_user_question" && playOnce("approval", ASSETS.approval, "tools/execute:ask_user_question")) {
					log("event tools/execute ask_user_question");
				}
			} catch { /* ignore */ }
			return typeof next === "function" ? next() : undefined;
		}), "dsh-audio-cue: ask_user_question");
	}

	log("v" + VERSION + " 已加载：approval=" + cfg.approval + " ask=" + cfg.ask + " turnEnd=" + cfg.turnEnd +
		" ignoreSubagents=" + cfg.ignoreSubagents + " fallbackTurnStopping=" + cfg.fallbackTurnStopping + " selfTest=" + cfg.selfTest);
	log("players=" + JSON.stringify(PLAYERS) + " | assets: approval=" + existsSync(ASSETS.approval) + " turnEnd=" + existsSync(ASSETS.turnEnd));

	// ⑤ 自检音（默认关）：只用来验证宿主播放链路。
	if (cfg.selfTest) {
		try {
			const timer = setTimeout(() => {
				log("self-test：播放 approval.wav");
				play(ASSETS.approval, "self-test");
			}, cfg.selfTestMs);
			if (typeof timer?.unref === "function") timer.unref();
		} catch (e) { log("self-test schedule failed: " + e.message); }
	}
}
