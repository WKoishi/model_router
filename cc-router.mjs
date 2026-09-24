#!/usr/bin/env node
// cc-router：按请求体中的 model 字段，把 Claude Code 的 API 请求分流到两个上游。
//
// 本程序不保存任何上游地址或密钥。所有配置由 Claude Code 通过
// ANTHROPIC_CUSTOM_HEADERS 以 x-router-* 请求头传入，转发前全部剥离。
// 除必要的鉴权替换外，请求与响应（头与体）均原样透传，不解压、不重新编码。

import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 4000;
const DEFAULT_MATCH = "sonnet-5";

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

function parseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法的 URL：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} 只支持 http/https：${value}`);
  }
  return url;
}

async function handle(req, res) {
  const started = Date.now();
  const h = req.headers;

  if (!h["x-router-main-url"] || !h["x-router-cheap-url"] || !h["x-router-cheap-key"]) {
    return fail(res, 400,
      "缺少 x-router-main-url / x-router-cheap-url / x-router-cheap-key 请求头，" +
      "请检查 ~/.claude/settings.json 中的 ANTHROPIC_CUSTOM_HEADERS");
  }

  let mainUrl, cheapUrl, matchRe;
  try {
    mainUrl = parseUrl(h["x-router-main-url"], "x-router-main-url");
    cheapUrl = parseUrl(h["x-router-cheap-url"], "x-router-cheap-url");
    matchRe = new RegExp(h["x-router-cheap-match"] || DEFAULT_MATCH);
  } catch (e) {
    return fail(res, 400, e.message);
  }

  let body = await readBody(req);
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
    name.startsWith("x-router-") ||
    HOP_BY_HOP.has(name) ||
    (toCheap && (name === "authorization" || name === "x-api-key")));

  if (toCheap) {
    // 鉴权方式默认与 Claude Code 发来的一致，可用 x-router-cheap-auth 覆盖
    const style = h["x-router-cheap-auth"] || ("authorization" in h ? "bearer" : "x-api-key");
    if (style === "bearer") headers["authorization"] = `Bearer ${h["x-router-cheap-key"]}`;
    else headers["x-api-key"] = h["x-router-cheap-key"];

    const rewrite = h["x-router-cheap-model"];
    if (rewrite && json) {
      json.model = rewrite;
      body = Buffer.from(JSON.stringify(json));
    }
  }

  if (body.length > 0) headers["content-length"] = String(body.length);

  const target = new URL(base.href.replace(/\/+$/, "") + req.url);
  const client = target.protocol === "https:" ? https : http;

  const upReq = client.request(target, { method: req.method, headers }, (upRes) => {
    const outHeaders = copyHeaders(upRes.rawHeaders, (name) => HOP_BY_HOP.has(name));
    res.writeHead(upRes.statusCode, upRes.statusMessage, outHeaders);
    log(req.method, req.url, `model=${model || "-"}`, `-> ${route}`,
      upRes.statusCode, `${Date.now() - started}ms`);
    pipeline(upRes, res, (err) => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        log("响应转发中断:", err.message);
      }
    });
  });

  upReq.on("error", (err) => {
    log(req.method, req.url, `model=${model || "-"}`, `-> ${route}`, "上游错误:", err.message);
    fail(res, 502, `上游（${route}）请求失败：${err.message}`);
  });

  // Claude Code 中途断开时，同时取消上游请求
  res.on("close", () => {
    if (!res.writableFinished) upReq.destroy();
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
