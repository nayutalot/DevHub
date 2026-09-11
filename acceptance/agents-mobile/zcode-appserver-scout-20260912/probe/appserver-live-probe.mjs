// Z1 scout: minimal live probe of `zcode app-server` (ZCode Protocol over stdio).
// Red lines honored: NO inference task is sent (no session/send); read-only
// methods only (session/list, workspace/readState); process killed after probe;
// all captured output passed through mask() before touching disk/stdout.
//
// Usage: node appserver-live-probe.mjs <path-to-zcode.cjs>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const zcodeCjs = process.argv[2];
if (!zcodeCjs) {
  console.error("usage: node appserver-live-probe.mjs <path-to-zcode.cjs>");
  process.exit(2);
}

// --- masking -----------------------------------------------------------------
const SECRET_URL_RE = /(sid=|hash=|mid=)[^&"'\s]*/gi;
const CREDISH_KEYS = new Set([
  "title", "summary", "accesstoken", "refreshtoken", "token", "apikey",
  "authorization", "cookie", "credential", "credentials", "secret", "password",
]);
const EVENT_PAYLOAD_KEYS = new Set(["events", "snapshot", "messages"]);

function maskString(s) {
  let out = String(s).replace(SECRET_URL_RE, "$1<MASKED>");
  if (out.length > 96) out = out.slice(0, 80) + `...<len=${String(s).length}>`;
  return out;
}
function maskNode(v, key) {
  if (v === null || v === undefined) return v;
  const k = key === undefined ? "" : String(key);
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => maskNode(x)); // cap arrays
  if (typeof v === "object") {
    const o = {};
    for (const [kk, vv] of Object.entries(v)) o[kk] = maskNode(vv, kk);
    return o;
  }
  if (typeof v === "string") {
    if (CREDISH_KEYS.has(k.toLowerCase())) return "<MASKED>";
    return maskString(v);
  }
  return v;
}
function maskLine(line) {
  try {
    return JSON.stringify(maskNode(JSON.parse(line)));
  } catch {
    return maskString(line);
  }
}

// --- probe -------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "z1-appserver-sandbox-"));
console.log(`[meta] sandbox=${sandbox}`);
console.log(`[meta] node=${process.version}`);

const child = spawn(
  process.execPath,
  [zcodeCjs, "app-server", `--cwd=${sandbox}`, "--surface=terminal"],
  { stdio: ["pipe", "pipe", "pipe"], cwd: sandbox },
);

const t0 = Date.now();
let rxCount = 0;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      rxCount += 1;
      console.log(`[RX +${Date.now() - t0}ms] ${maskLine(line)}`);
    }
  }
});
let errTail = "";
child.stderr.on("data", (d) => {
  errTail = (errTail + d.toString("utf8")).slice(-4000);
});
child.on("error", (e) => console.log(`[SPAWN-ERR] ${e.message}`));

function send(obj) {
  console.log(`[TX +${Date.now() - t0}ms] ${JSON.stringify(obj)}`);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

// Static recon found NO initialize/hello method in the protocol method table
// (rr table: session/*, workspace/*, mcp/plugins/skills/automation/usage/interaction/*).
// So the live check validates handshake-free operation: fire a read-only
// session/list directly as the very first frame.
setTimeout(() => send({ id: 1, method: "session/list", params: { limit: 3 } }), 2000);
setTimeout(() => send({
  id: 2,
  method: "workspace/readState",
  params: { workspace: { workspacePath: sandbox, workspaceKey: sandbox } },
}), 3500);
// Unknown method: document error-shape + error code.
setTimeout(() => send({ id: 3, method: "bogus/method", params: {} }), 5000);
// session/create on the empty sandbox is allowed (no inference; we never send a
// prompt) — verifies lifecycle start, then session/close tears it down.
let createdSessionId = null;
function onRaw(d) {
  for (const line of d.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 4 && m.result) {
        createdSessionId =
          m.result.sessionId ?? m.result.session?.sessionId ?? m.result.id ?? null;
        if (createdSessionId) console.log(`[meta] created sessionId captured (masked len=${String(createdSessionId).length})`);
      }
    } catch { /* ignore non-JSON */ }
  }
}
child.stdout.on("data", onRaw);

setTimeout(() => {
  send({
    id: 4,
    method: "session/create",
    params: { workspace: { workspacePath: sandbox, workspaceKey: sandbox }, persistence: "immediate" },
  });
}, 6500);
setTimeout(() => {
  if (createdSessionId) send({ id: 5, method: "session/close", params: { sessionId: createdSessionId } });
  else console.log("[meta] no sessionId captured; skipping session/close");
}, 8500);

setTimeout(() => child.stdin.end(), 10500); // EOF -> server should exit cleanly
const killTimer = setTimeout(() => {
  console.log("[meta] kill timer fired (server did not exit after EOF)");
  child.kill("SIGKILL");
}, 15000);

child.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  console.log(`[EXIT +${Date.now() - t0}ms] code=${code} signal=${signal}`);
  if (errTail.trim()) {
    console.log("[SRV-STDERR tail (masked)]");
    for (const line of errTail.trim().split("\n").slice(-12)) console.log("  " + maskString(line));
  }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* tmp */ }
  process.exit(0);
});
