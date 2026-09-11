// Z1 scout run2: full session lifecycle on `zcode app-server` with the host
// answering server->client requests. Still ZERO inference (no session/send).
// Steps: session/list (read-only) -> session/create -> capture sessionId ->
// session/close -> EOF. Server requests are answered with safe minimal results.
// All output passes mask() (titles/creds/URL params redacted) before printing.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const zcodeCjs = process.argv[2];
if (!zcodeCjs) { console.error("usage: node appserver-lifecycle-probe.mjs <zcode.cjs>"); process.exit(2); }

const SECRET_URL_RE = /(sid=|hash=|mid=)[^&"'\s]*/gi;
const CREDISH_KEYS = new Set(["title", "summary", "accesstoken", "refreshtoken", "token", "apikey", "authorization", "cookie", "credential", "credentials", "secret", "password"]);
function maskString(s) { let o = String(s).replace(SECRET_URL_RE, "$1<MASKED>"); if (o.length > 96) o = o.slice(0, 80) + `...<len=${String(s).length}>`; return o; }
function maskNode(v, key) {
  if (v === null || v === undefined) return v;
  const k = key === undefined ? "" : String(key);
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => maskNode(x));
  if (typeof v === "object") { const o = {}; for (const [kk, vv] of Object.entries(v)) o[kk] = maskNode(vv, kk); return o; }
  if (typeof v === "string") { if (CREDISH_KEYS.has(k.toLowerCase())) return "<MASKED>"; return maskString(v); }
  return v;
}
const maskLine = (l) => { try { return JSON.stringify(maskNode(JSON.parse(l))); } catch { return maskString(l); } };

const sandbox = mkdtempSync(join(tmpdir(), "z1-appserver-lc-"));
console.log(`[meta] sandbox=${sandbox} node=${process.version}`);
const child = spawn(process.execPath, [zcodeCjs, "app-server", `--cwd=${sandbox}`, "--surface=terminal"], { stdio: ["pipe", "pipe", "pipe"], cwd: sandbox });
const t0 = Date.now();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8"); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
let errTail = "";
child.stderr.on("data", (d) => { errTail = (errTail + d.toString("utf8")).slice(-3000); });

function send(o) { console.log(`[TX +${Date.now() - t0}ms] ${JSON.stringify(o).slice(0, 300)}`); child.stdin.write(JSON.stringify(o) + "\n"); }
function handle(line) {
  let m = null; try { m = JSON.parse(line); } catch { console.log(`[RX?] ${maskString(line)}`); return; }
  // Server->client request: answer so lifecycle can proceed.
  if (m.id !== undefined && m.method) {
    console.log(`[SRV-REQ +${Date.now() - t0}ms] ${maskLine(line)}`);
    if (m.method === "session/requestRuntimePreferences") {
      send({ id: m.id, result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" } });
    } else {
      send({ id: m.id, error: { code: -32601, message: "probe: method not supported" } });
    }
    return;
  }
  console.log(`[RX +${Date.now() - t0}ms] ${maskLine(line)}`);
  if (m.id === 4 && m.result) {
    const sid = m.result.sessionId ?? m.result.session?.sessionId ?? null;
    if (sid) setTimeout(() => send({ id: 5, method: "session/close", params: { sessionId: sid } }), 700);
    else console.log(`[meta] create result keys=${Object.keys(m.result).join(",")}`);
  }
}

setTimeout(() => send({ id: 4, method: "session/create", params: { workspace: { workspacePath: sandbox, workspaceKey: sandbox }, persistence: "immediate" } }), 9000);
setTimeout(() => child.stdin.end(), 20000);
const killTimer = setTimeout(() => { console.log("[meta] kill timer fired"); child.kill("SIGKILL"); }, 26000);
child.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  console.log(`[EXIT +${Date.now() - t0}ms] code=${code} signal=${signal}`);
  if (errTail.trim()) { console.log("[SRV-STDERR tail (masked)]"); for (const l of errTail.trim().split("\n").slice(-10)) console.log("  " + maskString(l)); }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { }
  process.exit(0);
});
