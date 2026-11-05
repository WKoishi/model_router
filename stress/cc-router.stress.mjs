// cc-router 压力测试：超长上下文（大请求体）与超长思考链（长时间 SSE 流）。
//
// 与 test/ 一样只用本地假上游，不访问真实上游，不需要任何 key。
// 假上游使用 HTTPS（临时自签证书，需要 openssl），与真实部署一致。
// 完整运行约 6 分钟，因此不放在 test/ 下，默认的 node --test 不会运行它：
//
//   node --test stress/cc-router.stress.mjs
//
// 可用环境变量缩短时长（仅用于调试脚本本身，结论以默认值为准）：
//   STRESS_STREAM_SECONDS  思考流总时长，默认 330（需 > 300 才能越过 Node 默认的 server.requestTimeout）
//   STRESS_TTFB_SECONDS    上游迟迟不回响应头的时长，默认 120

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROUTER = fileURLToPath(new URL("../cc-router.mjs", import.meta.url));
const STREAM_S = Number(process.env.STRESS_STREAM_SECONDS) || 330;
const TTFB_S = Number(process.env.STRESS_TTFB_SECONDS) || 120;

let tmpDir, cert, upstream, upPort, router, routerPort;
let logs = "";
const records = new Map(); // x-test-id -> 假上游侧的记录
let tickStop = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1) + "MB";
const ms = (n) => n.toFixed(0) + "ms";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// 可复现的伪随机数
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 构造与 Claude Code 结构一致的超长请求体 ----------

const CODE_LINES = [
  'const res = await fetch(`${base}/v1/items?id=${id}&q=${encodeURIComponent(q)}`, { method: "POST" });',
  '\tif (err) return reply.status(500).send({ "error": err.message, "code": err.code });',
  'const winPath = "C:\\\\Users\\\\dev\\\\project\\\\src\\\\index.ts";',
  "// TODO: handle the edge case where x < 0 && y > 0 || z === undefined",
  'printf("%s\\t%d\\n", name, count);',
  "SELECT * FROM users WHERE name = 'O''Brien' AND created_at > NOW() - INTERVAL '7 days';",
  '  return {"key": [1, 2.5e-3, null, true, "\\u0000"], "nested": {"a": {"b": []}}};',
  "<div class=\"row\" data-x='{\"a\":1}'>&nbsp;&lt;tag&gt;</div>",
  "    for (int i = 0; i < n; ++i) { sum += a[i] * b[i]; }",
  "def jacobian(q: np.ndarray) -> np.ndarray:  # returns 6xN",
];
const CJK_LINES = [
  "// 计算机械臂末端执行器的雅可比矩阵 🤖",
  "# 注意：这里的单位是毫米（mm），不是米；角度用弧度 θ ∈ [-π, π]",
  'log.info("任务完成 ✅ 耗时 %d 秒，误差 ±0.5°", t);',
  "/* 日本語のコメント・한국어 주석・emoji 👨‍👩‍👧 */",
];
const WORDS = "the of model token cache request stream proxy upstream thinking signature budget context window message block delta latency tool result assistant user system".split(" ");

// 粗略估算 token：ASCII 约 4 字符 1 个 token，非 ASCII 约 1 字符 1 个 token
function estTokens(s) {
  let ascii = 0, other = 0;
  for (const ch of s) ch.charCodeAt(0) < 128 ? ascii++ : other++;
  return ascii / 4 + other;
}

function makeBody({ tokens, cjk = false, images = 0, imageBytes = 1_200_000, seed = 1 }) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const code = (lines) => {
    const out = [];
    for (let i = 0; i < lines; i++) {
      out.push(cjk && r() < 0.25 ? pick(CJK_LINES) : pick(CODE_LINES));
      if (r() < 0.3) out.push(`  let v_${Math.floor(r() * 1e9).toString(36)} = 0x${Math.floor(r() * 1e9).toString(16)};`);
    }
    return out.join("\n");
  };
  const prose = (words) => {
    const out = [];
    for (let i = 0; i < words; i++) out.push(cjk && r() < 0.1 ? "考虑上下文" : pick(WORDS));
    return out.join(" ") + ".";
  };
  const b64 = (n) => crypto.randomBytes(n).toString("base64");

  let est = 0;
  const count = (s) => { est += estTokens(s); return s; };

  const tools = Array.from({ length: 30 }, (_, i) => ({
    name: `Tool${i}`,
    description: count(prose(300)),
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: count(prose(20)) }, limit: { type: "number" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  }));
  const system = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=claude-vscode;" },
    { type: "text", text: count(prose(4000)), cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  const messages = [{ role: "user", content: [{ type: "text", text: count(prose(200)) }] }];

  let imagesLeft = images;
  const imageEvery = images > 0 ? Math.max(1, Math.floor(tokens / 20000 / (images + 1))) : Infinity;
  let turn = 0;
  while (est < tokens) {
    turn++;
    const toolId = `toolu_${crypto.createHash("md5").update(String(turn)).digest("hex").slice(0, 24)}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: count(prose(300 + Math.floor(r() * 1500))), signature: b64(600 + Math.floor(r() * 900)) },
        { type: "text", text: count(prose(30)) },
        { type: "tool_use", id: toolId, name: "Read", input: { file_path: `/home/user/src/module_${turn}.ts` } },
      ],
    });
    const content = [{ type: "text", text: count(code(150 + Math.floor(r() * 600))) }];
    if (imagesLeft > 0 && turn % imageEvery === 0) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(imageBytes) } });
      imagesLeft--;
      est += 1600;
    }
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content }] });
  }
  for (; imagesLeft > 0; imagesLeft--) {
    messages.at(-1).content[0].content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(imageBytes) } });
  }
  messages.at(-1).content.push({ type: "text", text: "continue", cache_control: { type: "ephemeral", ttl: "1h" } });

  const obj = {
    model: "claude-opus-5-5",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    tools,
    messages,
    metadata: { user_id: "user_stress_test" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    stream: true,
  };
  return { obj, buf: Buffer.from(JSON.stringify(obj)), tokens: Math.round(est), images };
}

// ---------- 假上游（HTTPS） ----------

const sse = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const MESSAGE_START = (model) => sse("message_start", {
  message: {
    id: "msg_stress", type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 999_000, output_tokens: 1 },
  },
});

function startStream(res, rec) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "request-id": "req_stress" });
  rec.hash = crypto.createHash("sha256");
  rec.sent = [];
  rec.bytes = 0;
  return (s) => {
    rec.hash.update(s);
    rec.bytes += Buffer.byteLength(s);
    rec.sent.push(performance.now());
    return res.write(s);
  };
}

function endStream(res, rec, emit) {
  emit(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 128000 } }));
  emit(sse("message_stop"));
  rec.hash = rec.hash.digest("hex");
  res.end();
}

// 长思考：先持续输出 thinking_delta，中途完全静默一段时间（不发 ping），最后输出签名和正文
async function streamThinking(res, rec, totalS, model) {
  const T = totalS * 1000;
  const quietFrom = T * 0.18, quietTo = T * 0.45, textFrom = T * 0.94;
  const r = rng(7);
  const emit = startStream(res, rec);
  emit(MESSAGE_START(model));
  emit(sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
  const t0 = performance.now();
  let lastPing = 0;
  for (;;) {
    if (res.destroyed) return;
    const t = performance.now() - t0;
    if (t >= textFrom) break;
    if (t >= quietFrom && t < quietTo) {
      rec.quietMs = quietTo - t;
      await sleep(quietTo - t);
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const n = 1 + Math.floor(r() * 6);
      const words = Array.from({ length: n }, () => (r() < 0.15 ? "思考" : WORDS[Math.floor(r() * WORDS.length)]));
      emit(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: " " + words.join(" ") } }));
    }
    if (r() < 0.003) emit(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "长".repeat(8000) } }));
    if (t - lastPing > 15000) { emit(sse("ping")); lastPing = t; }
    await sleep(20);
  }
  emit(sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: crypto.randomBytes(1200).toString("base64") } }));
  emit(sse("content_block_stop", { index: 0 }));
  emit(sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }));
  while (performance.now() - t0 < T) {
    if (res.destroyed) return;
    emit(sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: " 结论" } }));
    await sleep(50);
  }
  emit(sse("content_block_stop", { index: 1 }));
  endStream(res, rec, emit);
}

async function upstreamHandler(req, res) {
  const id = req.headers["x-test-id"];
  const scenario = req.headers["x-test-scenario"] || "digest";
  const params = JSON.parse(req.headers["x-test-params"] || "{}");
  const rec = { url: req.url, headers: req.headers, received: performance.now() };
  records.set(id, rec);

  const hash = crypto.createHash("sha256");
  const chunks = params.keepBody ? [] : null;
  let len = 0;
  for await (const c of req) {
    hash.update(c);
    len += c.length;
    chunks?.push(c);
  }
  rec.bodyLen = len;
  rec.bodySha = hash.digest("hex");
  rec.bodyDone = performance.now();
  if (chunks) rec.body = Buffer.concat(chunks);

  if (scenario === "digest") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ len, sha: rec.bodySha }));
  } else if (scenario === "ttfb") {
    // 模拟超长上下文的预填充：收完请求体后很久都不回任何字节
    await sleep(params.seconds * 1000);
    if (res.destroyed) return;
    const emit = startStream(res, rec);
    emit(MESSAGE_START("claude-opus-5-5"));
    emit(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    emit(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }));
    emit(sse("content_block_stop", { index: 0 }));
    endStream(res, rec, emit);
  } else if (scenario === "think") {
    await streamThinking(res, rec, params.seconds, "claude-opus-5-5");
  } else if (scenario === "flood") {
    // 尽快输出 params.mb MB 的 SSE，遵守背压
    const emit = startStream(res, rec);
    emit(MESSAGE_START("claude-opus-5-5"));
    const chunk = "x".repeat(900);
    while (rec.bytes < params.mb * 1048576) {
      if (res.destroyed) return;
      if (!emit(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: chunk } }))) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    endStream(res, rec, emit);
  } else if (scenario === "tick") {
    // 背景流：每 params.interval ms 一个事件，直到测试把 tickStop 置为 true
    const emit = startStream(res, rec);
    emit(MESSAGE_START("claude-opus-5-5"));
    while (!tickStop && !res.destroyed) {
      emit(sse("ping"));
      await sleep(params.interval);
    }
    endStream(res, rec, emit);
  }
}

// ---------- 客户端 ----------

function routerValue(opts = {}) {
  const cfg = {
    main: `https://127.0.0.1:${upPort}/main`,
    cheap: `https://127.0.0.1:${upPort}/cheap`,
    key: "CHEAPKEY",
    ...opts,
  };
  return Object.entries(cfg).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("; ");
}

// via=router 经代理（http）；via=direct 直连假上游（https），作为对照
function send({ via = "router", agent, scenario = "digest", params = {}, body, chunked = false, routerOpts = {}, onResponse } = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json",
      "authorization": "Bearer MAINKEY",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
      "x-test-id": id,
      "x-test-scenario": scenario,
      "x-test-params": JSON.stringify(params),
    };
    if (via === "router") headers["x-router"] = routerValue(routerOpts);
    if (!chunked) headers["content-length"] = String(body.length);
    const opts = via === "router"
      ? { host: "127.0.0.1", port: routerPort, path: "/v1/messages?beta=true", method: "POST", headers, agent }
      : { host: "127.0.0.1", port: upPort, path: "/main/v1/messages?beta=true", method: "POST", headers, agent, ca: cert };
    const started = performance.now();
    const req = (via === "router" ? http : https).request(opts, (res) => {
      const out = { id, status: res.statusCode, headers: res.headers, reusedSocket: req.reusedSocket, started, arrivals: [], bytes: 0 };
      const hash = crypto.createHash("sha256");
      const keep = [];
      let prev = "";
      res.on("data", (c) => {
        const now = performance.now();
        hash.update(c);
        out.bytes += c.length;
        if (out.bytes <= 65536) keep.push(c);
        // 按 \n\n 统计 SSE 事件到达时间（latin1 按字节解码，不会被多字节字符截断影响）
        const s = prev + c.toString("latin1");
        for (let i = s.indexOf("\n\n"); i >= 0; i = s.indexOf("\n\n", i + 2)) out.arrivals.push(now);
        prev = s.at(-1) ?? "";
      });
      res.on("end", () => {
        out.ended = performance.now();
        out.hash = hash.digest("hex");
        out.text = Buffer.concat(keep).toString();
        out.rec = records.get(id);
        resolve(out);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("响应被中断")));
      onResponse?.(res);
    });
    req.on("error", reject);
    if (!chunked) return req.end(body);
    // 分块上传（transfer-encoding: chunked），遵守背压
    (async () => {
      for (let i = 0; i < body.length; i += 65536) {
        if (!req.write(body.subarray(i, i + 65536))) await new Promise((r) => req.once("drain", r));
      }
      req.end();
    })();
  });
}

// ---------- 代理进程的内存 ----------

function procStatus(field) {
  try {
    const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(fs.readFileSync(`/proc/${router.pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// 用 /proc/<pid>/clear_refs 重置峰值 RSS（VmHWM），测出每个场景各自的峰值及相对起点的增量；
// 前一场景释放的内存未必已归还系统，所以看增量更准确。非 Linux 返回 null
async function peakRss(fn) {
  let base = null;
  try {
    fs.writeFileSync(`/proc/${router.pid}/clear_refs`, "5");
    base = procStatus("VmRSS");
  } catch {}
  const result = await fn();
  const peak = base === null ? null : procStatus("VmHWM");
  return { result, peak, growth: base === null ? null : peak - base };
}
const fmtPeak = (p, g) => (p === null ? "n/a" : `${mb(p)}（增加 ${mb(g)}）`);

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p99: q(0.99), max: s.at(-1) };
}

function maxGap(times, from = -Infinity, to = Infinity) {
  let g = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] >= from && times[i - 1] <= to) g = Math.max(g, times[i] - times[i - 1]);
  }
  return g;
}

// ---------- 启动与清理 ----------

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-router-stress-"));
  const keyFile = path.join(tmpDir, "key.pem"), certFile = path.join(tmpDir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: "ignore" });
  cert = fs.readFileSync(certFile);

  [upPort, routerPort] = await Promise.all([freePort(), freePort()]);
  upstream = https.createServer({ key: fs.readFileSync(keyFile), cert }, (req, res) => {
    upstreamHandler(req, res).catch((e) => { console.error("假上游错误", e); res.destroy(); });
  });
  await new Promise((r) => upstream.listen(upPort, "127.0.0.1", r));

  // 代理用默认配置运行，只额外信任假上游的自签证书
  router = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, PORT: String(routerPort), NODE_EXTRA_CA_CERTS: certFile },
  });
  router.stdout.on("data", (d) => { logs += d; });
  router.stderr.on("data", (d) => { logs += d; });
  const deadline = Date.now() + 3000;
  while (!/已启动/.test(logs)) {
    if (Date.now() > deadline) throw new Error(`代理启动超时：\n${logs}`);
    await sleep(20);
  }
});

after(() => {
  router?.kill();
  upstream?.closeAllConnections();
  upstream?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- 场景一：超长上下文的大请求体 ----------

const BODIES = [
  { name: "约 70 万 token，纯 ASCII 代码", tokens: 700_000 },
  { name: "约 100 万 token，混合中文与 emoji", tokens: 1_000_000, cjk: true },
  { name: "约 90 万 token + 16 张图片（接近 API 的 32MB 上限）", tokens: 900_000, cjk: true, images: 16 },
];

test("大请求体：逐字节透传、分块上传、model 改写，并测量开销与内存", async (t) => {
  const agent = new http.Agent({ keepAlive: true });
  const directAgent = new https.Agent({ keepAlive: true, ca: cert });
  const rssIdle = procStatus("VmRSS");
  t.diagnostic(`代理空闲 RSS：${rssIdle ? mb(rssIdle) : "n/a"}`);

  // 背景流：模拟同时进行中的另一个会话，观察大请求体是否让代理的事件循环卡住
  tickStop = false;
  const tick = send({ agent, scenario: "tick", params: { interval: 10 }, body: Buffer.from(JSON.stringify({ model: "claude-opus-5-5" })) });
  await sleep(300);
  const windows = [];

  for (const [n, spec] of BODIES.entries()) {
    const { obj, buf, tokens } = makeBody({ ...spec, seed: n + 1 });
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const label = `${spec.name}：${mb(buf.length)}，估算 ${(tokens / 1000).toFixed(0)}k token`;

    // 1) 走 main，content-length 上传：逐字节一致
    const timesRouter = [], timesDirect = [];
    let peak = null, growth = null;
    for (let i = 0; i < 3; i++) {
      const w0 = performance.now();
      const { result: r, peak: p, growth: g } = await peakRss(() => send({ agent, body: buf }));
      windows.push([w0, performance.now(), spec.name]);
      if (p !== null && (peak === null || p > peak)) { peak = p; growth = g; }
      assert.equal(r.status, 200, r.text);
      assert.equal(r.rec.url, "/main/v1/messages?beta=true");
      assert.equal(r.rec.bodySha, sha, "上游收到的请求体与发送的不一致");
      assert.equal(r.rec.headers["content-length"], String(buf.length));
      assert.equal(r.rec.headers["anthropic-beta"], "claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07");
      timesRouter.push(r.ended - r.started);

      const d = await send({ via: "direct", agent: directAgent, body: buf });
      assert.equal(d.rec.bodySha, sha);
      timesDirect.push(d.ended - d.started);
    }

    // 2) 分块上传（无 content-length）：代理收齐后以 content-length 发出，内容一致
    const c = await send({ agent, body: buf, chunked: true });
    assert.equal(c.status, 200);
    assert.equal(c.rec.bodySha, sha);
    assert.equal(c.rec.headers["content-length"], String(buf.length));
    assert.equal(c.rec.headers["transfer-encoding"], undefined);

    // 3) 走 cheap 并改写 model：除 model 外语义一致，鉴权已替换
    const cheapBuf = Buffer.from(JSON.stringify({ ...obj, model: "claude-sonnet-5" }));
    const { result: m, peak: peakRewrite, growth: growthRewrite } = await peakRss(() =>
      send({ agent, body: cheapBuf, routerOpts: { model: "glm-5" }, params: { keepBody: true } }));
    assert.equal(m.status, 200);
    assert.equal(m.rec.url, "/cheap/v1/messages?beta=true");
    assert.equal(m.rec.headers.authorization, "Bearer CHEAPKEY");
    assert.equal(m.rec.headers["content-length"], String(m.rec.body.length));
    const got = JSON.parse(m.rec.body);
    assert.equal(got.model, "glm-5");
    assert.deepStrictEqual(got, { ...obj, model: "glm-5" });

    const median = (xs) => stats(xs).p50;
    t.diagnostic(label);
    t.diagnostic(`  耗时中位数：经代理 ${ms(median(timesRouter))}，直连 ${ms(median(timesDirect))}，` +
      `代理增加 ${ms(median(timesRouter) - median(timesDirect))}；分块上传 ${ms(c.ended - c.started)}；改写 model ${ms(m.ended - m.started)}`);
    t.diagnostic(`  代理峰值 RSS：透传 ${fmtPeak(peak, growth)}，改写 model ${fmtPeak(peakRewrite, growthRewrite)}`);
  }

  tickStop = true;
  const bg = await tick;
  assert.equal(bg.status, 200);
  assert.equal(bg.hash, bg.rec.hash);
  for (const name of new Set(windows.map((w) => w[2]))) {
    const ws = windows.filter((w) => w[2] === name);
    const g = Math.max(...ws.map(([a, b]) => maxGap(bg.arrivals, a, b)));
    t.diagnostic(`背景流（每 10ms 一个事件）在「${name}」期间的最大事件间隔：${ms(g)}`);
  }
  t.diagnostic(`背景流全程最大事件间隔：${ms(maxGap(bg.arrivals))}`);
  agent.destroy();
  directAgent.destroy();
});

// ---------- 场景二：大量输出 + 客户端读得慢（背压） ----------

test("背压：上游快速输出 50MB、客户端读得慢时，代理不囤积数据且内容完整", async (t) => {
  const agent = new http.Agent({ keepAlive: true });
  const body = Buffer.from(JSON.stringify({ model: "claude-opus-5-5", messages: [] }));
  const { result: r, peak, growth } = await peakRss(() => send({
    agent, scenario: "flood", params: { mb: 50 }, body,
    onResponse: (res) => {
      // 先 3 秒完全不读，之后每读 256KB 停 20ms
      res.pause();
      setTimeout(() => res.resume(), 3000);
      let since = 0;
      res.on("data", (c) => {
        since += c.length;
        if (since >= 262144) { since = 0; res.pause(); setTimeout(() => res.resume(), 20); }
      });
    },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.bytes, r.rec.bytes);
  assert.equal(r.hash, r.rec.hash);
  assert.equal(r.arrivals.length, r.rec.sent.length);
  t.diagnostic(`50MB 输出：耗时 ${ms(r.ended - r.started)}，代理峰值 RSS ${fmtPeak(peak, growth)}`);
  // 若代理不遵守背压，客户端暂停的 3 秒内会囤积几乎全部 50MB
  if (growth !== null) assert.ok(growth < 30 * 1048576, `代理 RSS 增加过多：${mb(growth)}`);
  agent.destroy();
});

// ---------- 场景三：长时间连接（两项并行，总耗时约 STREAM_S 秒） ----------

describe("长时间连接", { concurrency: true }, () => {
  test(`超长思考链：${STREAM_S}s 的 SSE 流，中途静默 ${(STREAM_S * 0.27).toFixed(0)}s，与直连对照`, async (t) => {
    const agent = new http.Agent({ keepAlive: true });
    const directAgent = new https.Agent({ keepAlive: true, ca: cert });
    const body = makeBody({ tokens: 200_000, seed: 9 }).buf;
    const [r, d] = await Promise.all([
      send({ agent, scenario: "think", params: { seconds: STREAM_S }, body }),
      send({ via: "direct", agent: directAgent, scenario: "think", params: { seconds: STREAM_S }, body }),
    ]);
    for (const [name, x] of [["经代理", r], ["直连", d]]) {
      assert.equal(x.status, 200);
      assert.equal(x.bytes, x.rec.bytes, `${name}：字节数不一致`);
      assert.equal(x.hash, x.rec.hash, `${name}：内容不一致`);
      assert.equal(x.arrivals.length, x.rec.sent.length, `${name}：事件数不一致`);
      const lat = stats(x.arrivals.map((a, i) => a - x.rec.sent[i]));
      t.diagnostic(`${name}：${(x.ended - x.started) / 1000 | 0}s，${mb(x.bytes)}，${x.arrivals.length} 个事件，` +
        `最长静默 ${ms(maxGap(x.arrivals))}，事件延迟 p50 ${lat.p50.toFixed(1)}ms / p99 ${lat.p99.toFixed(1)}ms / max ${lat.max.toFixed(1)}ms`);
      if (name === "经代理") assert.ok(lat.p99 < 200, `经代理的事件延迟过高：p99 ${lat.p99}ms`);
    }
    assert.ok(r.ended - r.started > STREAM_S * 1000 - 1000);
    assert.ok(maxGap(r.arrivals) >= r.rec.quietMs - 1000, "静默段没有生效");

    // 长连接结束后，同一条到代理的 keep-alive 连接还能继续使用
    const next = await send({ agent, body: Buffer.from(JSON.stringify({ model: "claude-opus-5-5" })) });
    assert.equal(next.status, 200);
    assert.equal(next.reusedSocket, true, "长流结束后客户端连接未被复用");
    agent.destroy();
    directAgent.destroy();
  });

  test(`超长上下文预填充：约 100 万 token 请求体，上游 ${TTFB_S}s 后才回响应头`, async (t) => {
    const agent = new http.Agent({ keepAlive: true });
    const { buf, tokens } = makeBody({ tokens: 1_000_000, cjk: true, seed: 11 });
    const r = await send({ agent, scenario: "ttfb", params: { seconds: TTFB_S }, body: buf });
    assert.equal(r.status, 200);
    assert.equal(r.hash, r.rec.hash);
    assert.equal(r.arrivals.length, r.rec.sent.length);
    assert.match(r.text, /event: message_stop/);
    assert.ok(r.ended - r.started >= TTFB_S * 1000);
    t.diagnostic(`${mb(buf.length)}（估算 ${(tokens / 1000).toFixed(0)}k token），首字节 ${ms(r.ended - r.started)}，响应完整`);
    agent.destroy();
  });
});

test("代理全程无错误日志，仍在运行", () => {
  assert.equal(router.exitCode, null);
  assert.doesNotMatch(logs, /内部错误|上游错误|响应转发中断|客户端已取消/);
  const ok = logs.match(/-> (main|cheap) 200 /g) ?? [];
  assert.ok(ok.length >= 20, `200 日志数量偏少：${ok.length}\n${logs}`);
});
