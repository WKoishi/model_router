# model_router

一个零依赖的本地转发代理：按请求中的模型名，把 Claude Code 的 API 请求分流到两个不同的上游。

典型用途：Claude Code 在 auto 模式下会调用 Sonnet 5 做安全检查（classifier），调用量不小。
用本代理可以把 Sonnet 5 的请求单独发往更便宜的上游，其余请求仍走原来的上游。

> 注意：分流只看模型名，默认会把**所有** Sonnet 5 请求发往上游 B，而不只是安全检查。
> 如果主会话切换到 Sonnet 5（如 `/model sonnet`）或子代理使用 Sonnet 5，这些请求同样会走上游 B。
> 可以用 `match` 项调整匹配规则。

```
Claude Code ──► http://127.0.0.1:4000 (cc-router)
                   ├─ model 匹配 sonnet-5 ──► 上游 B（cheap）
                   └─ 其他                ──► 上游 A（main）
```

## 特点

- **不保存任何密钥或地址**：所有配置都写在 `~/.claude/settings.json`，由 Claude Code 以请求头形式传给代理，本仓库不含任何隐私信息。
- **原样转发**：请求体逐字节透传（thinking 签名、`cache_control` 等不受影响）；请求头保留原始大小写与顺序；响应不解压、不重新编码，流式输出（SSE）实时转发。响应末尾的 HTTP trailer 不转发（Anthropic API 不使用）。
- **仅监听 `127.0.0.1`**：局域网内其他机器无法访问。
- **校验 `Host` 头**：只接受 `127.0.0.1` / `localhost` / `[::1]` 访问，防止外部网页通过 DNS rebinding 借用本代理。
- `x-router` 配置头在转发前剥离，不会泄露给任何上游。

## 环境要求

Node.js ≥ 20，无需 `npm install`。

```bash
node -v
```

## 配置

编辑 `~/.claude/settings.json`（注意：这是本机的私有文件，**不要**把它复制进本仓库）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_AUTH_TOKEN": "<上游 A 的 key>",
    "ANTHROPIC_CUSTOM_HEADERS": "x-router: main=https://<上游 A 地址>; cheap=https://<上游 B 地址>; key=<上游 B 的 key>"
  }
}
```

- `ANTHROPIC_BASE_URL` 请写 `127.0.0.1`，不要写 `localhost`：`localhost` 可能被解析成 IPv6 的 `::1`，而代理只监听 IPv4。
- 上游 A 的 key 照常用 `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`）或 `ANTHROPIC_API_KEY`（`x-api-key`）设置，代理原样转发给上游 A。
- 所有配置写在一个 `x-router` 请求头里，格式为 `名称=值`，各项用 `;` 分隔，前后空格随意，名称不区分大小写。
- 字符串必须写在一行内：JSON 字符串里不能直接回车换行。
- 值中不能含有 `;`（它是分隔符）。
- `main`、`cheap` 只填基础地址，不能带 `?` 或 `#`。

可用的配置项：

| 名称 | 必填 | 说明 |
|---|---|---|
| `main` | 是 | 上游 A 的基础地址，如 `https://api.anthropic.com` |
| `cheap` | 是 | 上游 B 的基础地址 |
| `key` | 是 | 上游 B 的 API key |
| `auth` | 否 | 上游 B 的鉴权方式：`bearer` 或 `x-api-key`（不区分大小写，其他值会报错）。默认与 Claude Code 发给上游 A 的方式相同 |
| `match` | 否 | 匹配模型名的正则，默认 `sonnet-5` |
| `model` | 否 | 发往上游 B 时把 `model` 改写成此值（上游 B 对模型的命名不同时使用）。设置后请求体会被重新序列化，不再逐字节透传 |

例如需要指定鉴权方式并改写模型名：

```json
"ANTHROPIC_CUSTOM_HEADERS": "x-router: main=https://<上游 A 地址>; cheap=https://<上游 B 地址>; key=<上游 B 的 key>; auth=x-api-key; model=<上游 B 的模型名>"
```

修改 settings.json 后需要重启 Claude Code 才会生效。

## 运行

### 手动运行（试用）

```bash
node cc-router.mjs
```

终端需保持打开，每个请求的去向会打印在这里，`Ctrl+C` 停止。可用环境变量 `PORT` 修改端口（默认 4000）；监听地址固定为 `127.0.0.1`，不可修改。

### systemd 用户服务（长期使用）

1. 编辑 `cc-router.service`，把 `ExecStart` 中的两个路径换成本机实际路径（`which node` 查看 node 路径）。
2. 安装并启动：

   ```bash
   mkdir -p ~/.config/systemd/user
   cp cc-router.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now cc-router
   ```

3. 常用命令：

   ```bash
   systemctl --user status cc-router     # 查看状态
   systemctl --user restart cc-router    # 重启
   journalctl --user -u cc-router -f     # 查看实时日志
   ```

> 使用 nvm 安装的 Node 升级版本后路径会变化，需要同步修改 `~/.config/systemd/user/cc-router.service` 并执行 `systemctl --user daemon-reload`。

## 验证

正常使用 Claude Code，观察日志：

```
2026-09-24T13:21:39.442Z POST /v1/messages?beta=true model=claude-opus-5-5 -> main 200 7ms
2026-09-24T13:21:39.450Z POST /v1/messages?beta=true model=claude-sonnet-5 -> cheap 200 1ms
2026-09-24T13:21:41.013Z POST /v1/messages?beta=true model=claude-opus-5-5 -> main 客户端已取消 1571ms
```

在 Claude Code 中按 Esc 中断请求时会记录「客户端已取消」，同时取消对应的上游请求，这不是错误。

日志只记录方法、路径、模型名、去向、状态码和耗时，不记录任何 key 或请求内容。

## 测试

```bash
node --test          # Node 20 使用：node --test test/
```

测试会在随机端口启动代理和一个本地假上游，不访问任何真实上游，也不需要任何 key。

## 故障排查

| 现象 | 原因 |
|---|---|
| Claude Code 报连接失败 | 代理没有运行，检查 `systemctl --user status cc-router`；或 `ANTHROPIC_BASE_URL` 写成了 `localhost`（可能被解析成 `::1`），应改为 `http://127.0.0.1:4000` |
| 返回 `[cc-router] x-router 缺少配置 ...` | `ANTHROPIC_CUSTOM_HEADERS` 没配置、漏了某一项，或没生效（改完需重启 Claude Code） |
| 返回 `[cc-router] 不再支持 x-router-... 等独立请求头` | 还在用旧写法，按上文改成单个 `x-router` 头 |
| 返回 `[cc-router] ... 混入了其他配置项` / `含有 \n` | 各项之间用了 `,`、空格或 `\n` 分隔，应改用 `;` |
| 返回 `[cc-router] ... 缺少 =` / `无法识别的项` / `重复配置` | 某项没写成 `名称=值`、名称拼错，或同一项写了两次 |
| 返回 `[cc-router] ... 不是合法的 URL` | 地址写错，需带 `https://` 前缀 |
| 返回 `[cc-router] ... 只填基础地址，不要带参数` | 地址里带了 `?` 或 `#`，删掉它们及之后的部分 |
| 返回 `[cc-router] auth 只能是 ...` | 鉴权方式写错，只能是 `bearer` 或 `x-api-key` |
| 返回 403 `[cc-router] 拒绝非本机 Host` | `ANTHROPIC_BASE_URL` 没用本机地址，应为 `http://127.0.0.1:4000` |
| 返回 `[cc-router] 上游（main/cheap）请求失败` | 对应上游网络不通或地址错误 |
| 上游返回 401 | 对应上游的 key 错误，或鉴权方式不对（可设置 `auth` 项） |

## 停用

从 `~/.claude/settings.json` 中删除 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_CUSTOM_HEADERS`（并把 key 改回直连上游所需的设置），重启 Claude Code，然后：

```bash
systemctl --user disable --now cc-router
```
