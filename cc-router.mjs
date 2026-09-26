#!/usr/bin/env node
// cc-router：按请求体中的 model 字段，把 Claude Code 的 API 请求分流到两个上游。
//
// 本程序不保存任何上游地址或密钥。所有配置由 Claude Code 通过
// ANTHROPIC_CUSTOM_HEADERS 以 x-router 请求头传入，转发前剥离。
// 除必要的鉴权替换外，请求与响应（头与体）均原样透传，不解压、不重新编码。

import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 4000;
const DEFAULT_MATCH = "sonnet-5";

// 只接受以本机地址访问的请求，防止 DNS rebinding 让外部网页借用本代理
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", HOST.toLowerCase()]);

// 逐跳头只对当前这一段连接有意义，不能转发
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding",
  "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fail(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `[cc-router] ${message}` },
  }));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// 从 rawHeaders 构造转发用的请求头，保留原始大小写与顺序；重复头合并为数组
function copyHeaders(rawHeaders, skip) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (skip(name.toLowerCase())) continue;
    if (name in out) out[name] = [].concat(out[name], value);
    else out[name] = value;
  }
  return out;
}

// x-router 头中可用的配置项（名称=值，各项用 ; 分隔）
const FIELDS = ["main", "cheap", "key", "auth", "match", "model"];
const REQUIRED = ["main", "cheap", "key"];
// 某项的值里又出现了「名称=」：多半是用了 , 或空格而不是 ; 来分隔
const MIXED_ITEM = new RegExp(`[\\s,]\\s*(?:${FIELDS.join("|")})\\s*=`, "i");

// 解析 x-router: main=...; cheap=...; key=...
// 顺带识别 settings.json 的常见写错。错误信息只报告项名，不回显值，避免把 key 打印出来。
function readConfig(rawHeaders) {
  const cfg = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const value = rawHeaders[i + 1];
    if (name.startsWith("x-router-")) {
      throw new Error(`不再支持 ${rawHeaders[i]} 等独立请求头，请改用单个请求头 x-router: main=...; cheap=...; key=...`);
    }
    if (name !== "x-router") continue;
    if (value.includes("\\n")) {
      throw new Error("x-router 的值中含有 \\n：各项之间用 ; 分隔即可，不需要换行");
    }
    value.split(";").map((s) => s.trim()).filter(Boolean).forEach((item, n) => {
      const eq = item.indexOf("=");
      if (eq < 0) throw new Error(`x-router 的第 ${n + 1} 项缺少 =，应为 名称=值`);
      const field = item.slice(0, eq).trim().toLowerCase();
      const val = item.slice(eq + 1).trim();
      if (!FIELDS.includes(field)) {
        throw new Error(`x-router 中有无法识别的项「${field}」，可用：${FIELDS.join(" / ")}`);
      }
      if (MIXED_ITEM.test(val)) {
        throw new Error(`x-router 的 ${field} 的值中混入了其他配置项：各项之间要用 ; 分隔`);
      }
      if (Object.hasOwn(cfg, field)) throw new Error(`x-router 中 ${field} 重复配置`);
      cfg[field] = val;
    });
  }
  return cfg;
}

function parseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法的 URL，需以 https:// 或 http:// 开头`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} 只支持 http/https`);
  }
  return url;
}

async function handle(req, res) {
  const started = Date.now();
  const h = req.headers;

  const hostname = (h.host || "").replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    return fail(res, 403, `拒绝非本机 Host：${h.host || "(空)"}`);
  }

  let cfg, mainUrl, cheapUrl, matchRe, cheapAuth;
  try {
    cfg = readConfig(req.rawHeaders);
    const missing = REQUIRED.filter((f) => !cfg[f]);
    if (missing.length > 0) {
      throw new Error(
        `x-router 缺少配置 ${missing.join("、")}，` +
        "请检查 ~/.claude/settings.json 中的 ANTHROPIC_CUSTOM_HEADERS");
    }
    mainUrl = parseUrl(cfg.main, "main");
    cheapUrl = parseUrl(cfg.cheap, "cheap");
    matchRe = new RegExp(cfg.match || DEFAULT_MATCH);
    cheapAuth = (cfg.auth || "").toLowerCase();
    if (cheapAuth && cheapAuth !== "bearer" && cheapAuth !== "x-api-key") {
      throw new Error(`auth 只能是 bearer 或 x-api-key：${cfg.auth}`);
    }
  } catch (e) {
    return fail(res, 400, e.message);
  }

  const tag = [req.method, req.url];
  let upReq = null;
  let clientGone = false;
  let upstreamFailed = false;

  // Claude Code 中途断开时（包括请求体还没收完时），同时取消上游请求
  res.on("close", () => {
    if (res.writableFinished || upstreamFailed) return;
    clientGone = true;
    log(...tag, "客户端已取消", `${Date.now() - started}ms`);
    upReq?.destroy();
  });

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    // 请求体没收完就断开了，已在 close 中记录
    if (err.code === "ECONNRESET") return;
    throw err;
  }
  if (clientGone) return;

  let json = null;
  let model = "";
  if (body.length > 0) {
    try {
      json = JSON.parse(body);
      if (typeof json?.model === "string") model = json.model;
    } catch {
      // 非 JSON 请求体：不参与分流，原样发往主上游
    }
  }

  const toCheap = model !== "" && matchRe.test(model);
  const route = toCheap ? "cheap" : "main";
  const base = toCheap ? cheapUrl : mainUrl;

  const headers = copyHeaders(req.rawHeaders, (name) =>
    name === "host" ||
    name === "content-length" ||
    name === "x-router" ||
    HOP_BY_HOP.has(name) ||
    (toCheap && (name === "authorization" || name === "x-api-key")));

  if (toCheap) {
    // 鉴权方式默认与 Claude Code 发来的一致，可用 auth 项覆盖
    const style = cheapAuth || ("authorization" in h ? "bearer" : "x-api-key");
    if (style === "bearer") headers["authorization"] = `Bearer ${cfg.key}`;
    else headers["x-api-key"] = cfg.key;

    const rewrite = cfg.model;
    if (rewrite && json) {
      json.model = rewrite;
      body = Buffer.from(JSON.stringify(json));
    }
  }

  if (body.length > 0) headers["content-length"] = String(body.length);

  const target = new URL(base.href.replace(/\/+$/, "") + req.url);
  const client = target.protocol === "https:" ? https : http;

  tag.push(`model=${model || "-"}`, `-> ${route}`);

  upReq = client.request(target, { method: req.method, headers }, (upRes) => {
    const outHeaders = copyHeaders(upRes.rawHeaders, (name) => HOP_BY_HOP.has(name));
    res.writeHead(upRes.statusCode, upRes.statusMessage, outHeaders);
    log(...tag, upRes.statusCode, `${Date.now() - started}ms`);
    upRes.on("error", () => { if (!clientGone) upstreamFailed = true; });
    pipeline(upRes, res, (err) => {
      if (err && !clientGone && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        log("响应转发中断:", err.message);
      }
    });
  });

  upReq.on("error", (err) => {
    // 客户端取消导致的上游中断已在 close 中记录，不算上游错误
    if (clientGone) return;
    log(...tag, "上游错误:", err.message);
    fail(res, 502, `上游（${route}）请求失败：${err.message}`);
  });

  upReq.end(body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log("内部错误:", err.message);
    fail(res, 500, err.message);
  });
});

server.listen(PORT, HOST, () => log(`cc-router 已启动：http://${HOST}:${PORT}`));
