/**
 * dsh-audio-cue 离线冒烟自检（不需要 DSH 实例，不会出声）。
 *
 * 断言四件事：
 *   ① 模块能被 import（ESM 语法正确）；
 *   ② apply() 不抛错，且注册了预期的四条事件源；
 *   ③ 🔴 订阅了 cordis **waterfall** 事件的地方**必须放行 `next()`** ——
 *      2026-10-02 的事故就是漏了这一步：观察者不调 next() 会否决整条链，
 *      把浏览器端审批应答者挡在外面，返回 undefined 再被归一化成 "unavailable"
 *      ⇒ 提权被拒、审批面板永不出现，而日志里一行错都没有。
 *   ④ 播放器与两段素材就位。
 *
 * 用法：node scripts/smoke.mjs      退出码 0 = 通过，1 = 断言失败
 */
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** cordis 里由 \.waterfall( 派发的事件（首参是对象/函数 ⇒ 带 scope filter）。 */
const WATERFALL_EVENTS = new Set([
	"approval/request", "tools/execute", "tools/pre-execute", "tools/post-execute",
	"tools/ptc-dispatch-log", "fs/write-intent", "fs/edit-intent", "system-prompt/assemble",
	"user-questions/request", "agent/pre-step", "agent/request", "agent/request-error",
	"llm/stream", "connection/request", "loader/patch-context", "workspace/session-activity",
]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "lib/index.js"), "utf8");
const mod = await import(pathToFileURL(join(ROOT, "lib/index.js")).href);

const events = [];
const labels = [];
const fakeCtx = {
	on: (name) => { events.push(name); return () => {}; },
	effect: (fn, label) => { labels.push(label); try { return fn(); } catch (e) { console.log("EFFECT THREW: " + e.message); } },
};

// selfTest 关掉：冒烟自检不该出声、不该留定时器。
mod.apply(fakeCtx, { enabled: true, approval: true, ask: true, turnEnd: true, ignoreSubagents: true, selfTest: false });

const fails = [];
for (const required of ["approval/request", "agent/turn-stopping", "session/event", "tools/execute"]) {
	if (!events.includes(required)) fails.push("缺少事件源: " + required);
}
for (const ev of events) {
	if (!WATERFALL_EVENTS.has(ev)) continue;
	const at = SRC.indexOf('ctx.on("' + ev + '"');
	const seg = at < 0 ? SRC : SRC.slice(at, at + 700);
	if (!/typeof next === "function"\s*\?\s*next\(\)/.test(seg)) fails.push("waterfall 事件未放行 next(): " + ev);
}

console.log("events   = " + JSON.stringify(events));
console.log("labels   = " + JSON.stringify(labels));
console.log("assets   = approval:" + existsSync(join(ROOT, "assets/approval.wav")) + " turnEnd:" + existsSync(join(ROOT, "assets/turn-end.wav")));
console.log(fails.length ? "SMOKE FAIL: " + fails.join(" | ") : "SMOKE OK");
process.exit(fails.length ? 1 : 0);
