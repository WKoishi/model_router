// cc-router 集成测试：启动真实的 cc-router 子进程和一个本地假上游，端到端验证行为。
// 运行：node --test（Node ≥ 22 自动发现；Node 18/20 用 node --test test/）

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROUTER = fileURLToPath(new URL("../cc-router.mjs", import.meta.url));

let upstream, upPort, router, routerPort;
let logs = "";
const upstreamEvents = []; // { url, finished } —— 上游侧每个请求的结束方式

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// 假上游：默认回显收到的请求；/slow、/stream、/die 模拟慢响应、流式响应、中途断开
function startUpstream() {
  upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const ev = { url: req.url, finished: false };
    upstreamEvents.push(ev);
    res.on("finish", () => { ev.finished = true; });

    if (req.url.endsWith("/slow")) {
      setTimeout(() => res.end("late"), 1500);
    } else if (req.url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => res.end("data: 2\n\n"), 1500);
    } else if (req.url.endsWith("/die")) {
      res.writeHead(200, { "content-length": "100" });
      res.write("part");
      setTimeout(() => res.socket.destroy(), 100);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body }));
    }
  });
  return new Promise((r) => upstream.listen(upPort, "127.0.0.1", r));
}

function startRouter() {
  router = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, PORT: String(routerPort), HOST: "127.0.0.1" },
  });
  router.stdout.on("data", (d) => { logs += d; });
  router.stderr.on("data", (d) => { logs += d; });
  return waitForLog(/已启动/);
}

async function waitForLog(re, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (re.test(logs)) return;
    await sleep(20);
  }
  assert.fail(`等待日志超时：${re}\n当前日志：\n${logs}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 构造 x-router 头的值；opts 覆盖默认配置项，值为 undefined 的项不写入
function routerValue(opts = {}) {
  const cfg = {
    main: `http://127.0.0.1:${upPort}/main`,
    cheap: `http://127.0.0.1:${upPort}/cheap`,
    key: "CHEAPKEY",
    ...opts,
  };
  return Object.entries(cfg)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function routerHeaders(opts = {}, extra = {}) {
  return rawRouterHeaders(routerValue(opts), extra);
}

function rawRouterHeaders(value, extra = {}) {
  return {
    "x-router": value,
    "authorization": "Bearer MAINKEY",
    "content-type": "application/json",
    ...extra,
  };
}

// 直接用 http.request 以便自定义 Host 头
function send({ path = "/v1/messages", method = "POST", headers = routerHeaders(), body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.host = host;
    const req = http.request(
      { host: "127.0.0.1", port: routerPort, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: data, json });
        });
      });
    req.on("error", reject);
    req.end(body);
  });
}

const modelBody = (model) => JSON.stringify({ model, messages: [] });

before(async () => {
  [upPort, routerPort] = await Promise.all([freePort(), freePort()]);
  await startUpstream();
  await startRouter();
});

after(() => {
  router.kill();
  upstream.close();
  upstream.closeAllConnections();
});

// ---------- Host 校验 ----------

test("Host：本机地址均被接受（带/不带端口、大小写、IPv6）", async () => {
  for (const host of [
    `127.0.0.1:${routerPort}`, `localhost:${routerPort}`, `LocalHost:${routerPort}`,
    `[::1]:${routerPort}`, "localhost", "127.0.0.1",
  ]) {
    const r = await send({ host, body: modelBody("claude-opus-5-5") });
    assert.equal(r.status, 200, `Host=${host}`);
  }
});

test("Host：非本机地址返回 403，且不访问上游", async () => {
  const before = upstreamEvents.length;
  for (const host of [
    `evil.example:${routerPort}`, "evil.example", `localhost.evil.example:${routerPort}`,
    `127.0.0.1.nip.io:${routerPort}`, `evil.example:${routerPort}:${routerPort}`,
  ]) {
    const r = await send({ host, body: modelBody("claude-opus-5-5") });
    assert.equal(r.status, 403, `Host=${host}`);
    assert.match(r.json.error.message, /拒绝非本机 Host/);
  }
  assert.equal(upstreamEvents.length, before);
});

test("Host：校验先于配置头检查", async () => {
  const r = await send({ host: "evil.example", headers: {}, body: "{}" });
  assert.equal(r.status, 403);
});

// ---------- 分流与头处理 ----------

test("分流：sonnet-5 走 cheap，其余走 main，非 JSON 走 main", async () => {
  let r = await send({ body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.url, "/cheap/v1/messages");
  r = await send({ body: modelBody("claude-opus-5-5") });
  assert.equal(r.json.url, "/main/v1/messages");
  r = await send({ body: "not json" });
  assert.equal(r.json.url, "/main/v1/messages");
  assert.equal(r.json.body, "not json");
});

test("头处理：x-router 被剥离，两个上游的 key 互不泄露", async () => {
  let r = await send({ body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.headers.authorization, "Bearer CHEAPKEY");
  assert.ok(!Object.keys(r.json.headers).some((k) => k.startsWith("x-router")));
  assert.ok(!JSON.stringify(r.json.headers).includes("MAINKEY"));

  r = await send({ body: modelBody("claude-opus-5-5") });
  assert.equal(r.json.headers.authorization, "Bearer MAINKEY");
  assert.ok(!Object.keys(r.json.headers).some((k) => k.startsWith("x-router")));
  assert.ok(!JSON.stringify(r.json.headers).includes("CHEAPKEY"));
});

test("请求体：默认逐字节透传；设置 model 项时改写 model", async () => {
  const raw = '{"model":"claude-sonnet-5",  "x": 1.0}';
  let r = await send({ body: raw });
  assert.equal(r.json.body, raw);

  r = await send({ headers: routerHeaders({ model: "other" }), body: raw });
  assert.equal(JSON.parse(r.json.body).model, "other");
  assert.equal(r.json.headers["content-length"], String(Buffer.byteLength(r.json.body)));
});

test("match 项：自定义匹配规则", async () => {
  const headers = routerHeaders({ match: "^claude-opus" });
  let r = await send({ headers, body: modelBody("claude-opus-5-5") });
  assert.equal(r.json.url, "/cheap/v1/messages");
  r = await send({ headers, body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.url, "/main/v1/messages");
});

// ---------- auth 项 ----------

test("auth：未设置时沿用 Claude Code 的鉴权方式", async () => {
  let r = await send({ body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.headers.authorization, "Bearer CHEAPKEY");
  assert.equal(r.json.headers["x-api-key"], undefined);

  const { authorization, ...rest } = routerHeaders();
  r = await send({ headers: { ...rest, "x-api-key": "MAINKEY" }, body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.headers["x-api-key"], "CHEAPKEY");
  assert.equal(r.json.headers.authorization, undefined);
});

test("auth：取值不区分大小写", async () => {
  for (const v of ["bearer", "Bearer", "BEARER"]) {
    const r = await send({ headers: routerHeaders({ auth: v }), body: modelBody("claude-sonnet-5") });
    assert.equal(r.json.headers.authorization, "Bearer CHEAPKEY", v);
    assert.equal(r.json.headers["x-api-key"], undefined, v);
  }
  for (const v of ["x-api-key", "X-Api-Key", "X-API-KEY"]) {
    const r = await send({ headers: routerHeaders({ auth: v }), body: modelBody("claude-sonnet-5") });
    assert.equal(r.json.headers["x-api-key"], "CHEAPKEY", v);
    assert.equal(r.json.headers.authorization, undefined, v);
  }
});

test("auth：非法取值返回 400，且不访问上游", async () => {
  const before = upstreamEvents.length;
  for (const v of ["apikey", "api-key", "basic", "bearer-token"]) {
    for (const model of ["claude-sonnet-5", "claude-opus-5-5"]) {
      const r = await send({ headers: routerHeaders({ auth: v }), body: modelBody(model) });
      assert.equal(r.status, 400, `${v} / ${model}`);
      assert.match(r.json.error.message, /auth 只能是 bearer 或 x-api-key/);
    }
  }
  assert.equal(upstreamEvents.length, before);
});

// ---------- x-router 格式 ----------

test("格式：容忍多余空格、空项、末尾分号和名称大小写", async () => {
  const value = ` Main = http://127.0.0.1:${upPort}/main ;;cheap=http://127.0.0.1:${upPort}/cheap;` +
    ` KEY=CHEAPKEY; Auth=X-Api-Key; `;
  const r = await send({ headers: rawRouterHeaders(value), body: modelBody("claude-sonnet-5") });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, "/cheap/v1/messages");
  assert.equal(r.json.headers["x-api-key"], "CHEAPKEY");
});

test("格式：值中的 =、: 以及地址里的 x-router、?key= 字样不影响解析", async () => {
  let r = await send({ headers: routerHeaders({ key: "K=E=Y" }), body: modelBody("claude-sonnet-5") });
  assert.equal(r.json.headers.authorization, "Bearer K=E=Y");

  r = await send({
    headers: routerHeaders({ main: `http://127.0.0.1:${upPort}/x-router-a:b` }),
    body: modelBody("claude-opus-5-5"),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, "/x-router-a:b/v1/messages");

  r = await send({
    headers: routerHeaders({ main: `http://127.0.0.1:${upPort}/main?key=1&auth=2` }),
    body: modelBody("claude-opus-5-5"),
  });
  assert.equal(r.status, 200);
});

test("格式：配置可拆到多个 x-router 头中", async () => {
  const r = await send({
    headers: rawRouterHeaders([
      `main=http://127.0.0.1:${upPort}/main; cheap=http://127.0.0.1:${upPort}/cheap`,
      "key=CHEAPKEY",
    ]),
    body: modelBody("claude-sonnet-5"),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.headers.authorization, "Bearer CHEAPKEY");
});

// ---------- 配置错误的提示 ----------

test("配置错误：返回 400 并指明原因，不访问上游，且错误信息不含 key", async () => {
  const main = `main=http://127.0.0.1:${upPort}/main`;
  const cheap = `cheap=http://127.0.0.1:${upPort}/cheap`;
  const cases = [
    // 拼错名称、缺少 =、重复
    [rawRouterHeaders(`${main}; ${cheap}; kye=SECRET`), /无法识别的项「kye」/],
    [rawRouterHeaders(`${main}; ${cheap}; SECRET`), /第 3 项缺少 =/],
    [rawRouterHeaders(`${main}; ${cheap}; key: SECRET`), /第 3 项缺少 =/],
    [rawRouterHeaders(`${main}; ${cheap}; key=SECRET; key=SECRET2`), /key 重复配置/],
    [rawRouterHeaders(`${main}; ${cheap}; key=SECRET; constructor=x`), /无法识别的项「constructor」/],
    // 缺少必填项
    [rawRouterHeaders(`${main}; key=SECRET`), /缺少配置 cheap/],
    [rawRouterHeaders(`${main}; ${cheap}; key=`), /缺少配置 key/],
    // 分隔符用错
    [rawRouterHeaders(`${main}, ${cheap}, key=SECRET`), /main 的值中混入了其他配置项：各项之间要用 ; 分隔/],
    [rawRouterHeaders(`${main} ${cheap} key=SECRET`), /main 的值中混入了其他配置项/],
    [rawRouterHeaders(`${main}\\n${cheap}\\nkey=SECRET`), /x-router 的值中含有 \\n/],
    // 地址写错（错误信息不回显值）
    [rawRouterHeaders(`main=SECRET; ${cheap}; key=k`), /main 不是合法的 URL/],
    [rawRouterHeaders(`main=ftp://SECRET; ${cheap}; key=k`), /main 只支持 http\/https/],
  ];
  const before = upstreamEvents.length;
  for (const [headers, re] of cases) {
    const r = await send({ headers, body: modelBody("claude-sonnet-5") });
    assert.equal(r.status, 400, String(re));
    assert.match(r.json.error.message, re);
    assert.doesNotMatch(r.json.error.message, /SECRET/);
  }
  assert.equal(upstreamEvents.length, before);
});

test("配置错误：缺少全部配置时列出缺少的项", async () => {
  const r = await send({ headers: { "content-type": "application/json" }, body: modelBody("claude-sonnet-5") });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /x-router 缺少配置 main、cheap、key/);
});

test("配置错误：旧的 x-router-* 写法给出迁移提示", async () => {
  const old = {
    "x-router-main-url": `http://127.0.0.1:${upPort}/main`,
    "x-router-cheap-url": `http://127.0.0.1:${upPort}/cheap`,
    "x-router-cheap-key": "SECRET",
  };
  for (const headers of [old, routerHeaders({}, { "x-router-cheap-auth": "bearer" })]) {
    const r = await send({ headers, body: modelBody("claude-sonnet-5") });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /不再支持 x-router-\S+ 等独立请求头，请改用单个请求头 x-router: main=\.\.\.; cheap=\.\.\.; key=\.\.\./);
    assert.doesNotMatch(r.json.error.message, /SECRET/);
  }
});

// ---------- 取消与上游错误的日志 ----------

test("取消：收到响应头前断开，记录「客户端已取消」并取消上游", async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: routerPort, path: "/case1/slow", method: "POST", headers: routerHeaders() });
    req.on("error", resolve);
    req.end(modelBody("m-cancel-early"));
    setTimeout(() => req.destroy(), 300);
  });
  await waitForLog(/\/case1\/slow model=m-cancel-early -> main 客户端已取消 \d+ms/);
  await sleep(1500); // 等过上游原本的响应时间
  assert.doesNotMatch(logs, /case1.*上游错误/);
  const ev = upstreamEvents.find((e) => e.url === "/main/case1/slow");
  assert.equal(ev.finished, false, "上游请求应被取消");
});

test("取消：流式输出中途断开，记录 200 和「客户端已取消」", async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: routerPort, path: "/case2/stream", method: "POST", headers: routerHeaders() }, (res) => {
      res.once("data", () => req.destroy());
      res.on("error", () => {});
      res.on("close", resolve);
    });
    req.on("error", () => {});
    req.end(modelBody("m-cancel-stream"));
  });
  await waitForLog(/\/case2\/stream model=m-cancel-stream -> main 客户端已取消/);
  assert.match(logs, /\/case2\/stream model=m-cancel-stream -> main 200 /);
  await sleep(1500);
  assert.doesNotMatch(logs, /响应转发中断: (?!aborted).*/);
  const ev = upstreamEvents.find((e) => e.url === "/main/case2/stream");
  assert.equal(ev.finished, false, "上游请求应被取消");
});

test("上游中途断开：记录「响应转发中断」，不误记为客户端取消", async () => {
  const before = logs.length;
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: routerPort, path: "/case3/die", method: "POST", headers: routerHeaders() }, (res) => {
      res.resume();
      res.on("error", () => {});
      res.on("close", resolve);
    });
    req.on("error", resolve);
    req.end(modelBody("m-upstream-dies"));
  });
  await waitForLog(/响应转发中断/);
  await sleep(200);
  const newLogs = logs.slice(before);
  assert.doesNotMatch(newLogs, /客户端已取消/);
});

test("上游不可达：返回 502 并记录「上游错误」", async () => {
  const deadPort = await freePort();
  const r = await send({
    path: "/case4",
    headers: routerHeaders({ main: `http://127.0.0.1:${deadPort}` }),
    body: modelBody("m-unreachable"),
  });
  assert.equal(r.status, 502);
  assert.match(r.json.error.message, /上游（main）请求失败/);
  await waitForLog(/\/case4 model=m-unreachable -> main 上游错误/);
  await sleep(100);
  assert.doesNotMatch(logs, /case4.*客户端已取消/);
});

test("正常完成的请求不记录「客户端已取消」", async () => {
  const r = await send({ path: "/case5/stream", body: modelBody("m-normal") });
  assert.equal(r.status, 200);
  assert.equal(r.body, "data: 1\n\ndata: 2\n\n");
  await sleep(100);
  assert.doesNotMatch(logs, /case5.*客户端已取消/);
});

test("所有用例后代理仍在运行且无内部错误", async () => {
  const r = await send({ body: modelBody("claude-opus-5-5") });
  assert.equal(r.status, 200);
  assert.equal(router.exitCode, null);
  assert.doesNotMatch(logs, /内部错误/);
});
