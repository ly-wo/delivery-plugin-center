# 插件市场 HTTP / MCP 服务

市场服务负责目录、搜索、详情、版本和发布包分发。两种接口复用 `server/catalog.mjs`，不导入宿主源码，不读取用户配置，不安装或执行插件。安装授权及后续管理仍由工作台完成。

## 启动

```sh
pnpm install --frozen-lockfile
pnpm start                         # 默认 HTTP，127.0.0.1:5499
pnpm start -- --port 5599           # 改端口
pnpm run start:mcp                 # MCP stdio，通常由客户端启动
```

也可以直接运行 `node server/index.mjs --transport http --port 5499` 或 `node server/index.mjs --transport mcp`。`stdio` 是 `mcp` 的别名。没有指定模式时固定使用 HTTP。

| 参数 | 环境变量 | 默认 |
| --- | --- | --- |
| `--port` | `PLUGIN_MARKET_PORT` | 5499 |
| `--host` | `PLUGIN_MARKET_HOST` | 127.0.0.1 |
| `--releases-dir` | `PLUGIN_MARKET_RELEASES_DIR` | 仓库 releases，独立于启动终端目录 |
| `--public-url` | `PLUGIN_MARKET_PUBLIC_URL` | 未指定；HTTP 本机地址，stdio 不提供 HTTP 下载地址 |

非回环监听必须配置 public-url，例如 `https://plugins.example.com`，不含路径、凭据或查询参数，用于 Host/Origin 校验和下载地址。服务发布维护者允许公开的目录和包；它不包含账号体系，私有分发需要反向代理认证。不要将私有包放进公开分发目录。SIGINT/SIGTERM 正常退出，只停止当前服务自己的连接。

## HTTP API

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 服务状态、目录及 MCP 入口 |
| `GET /catalog.json` | 与工作台目录协议一致的完整目录 |
| `GET /api/plugins` | 按 query、category 搜索；offset 默认 0，limit 默认 20、最多 100；每个插件返回最新版本 |
| `GET /api/plugins/:id` | 最新版本声明、权限、包名及摘要 |
| `GET /api/plugins/:id?version=1.0.0` | 固定版本详情 |
| `GET /api/plugins/:id/versions` | 所有版本，按版本号降序 |
| `GET /:filename.dwp` | 下载目录声明且摘要匹配的包；支持 HEAD |
| `POST /mcp` | 无状态 Streamable HTTP MCP |

分类为 capability、tool、application、uncategorized。HTTP JSON 成功时直接返回数据，错误返回 `{ "message": "..." }`，分别使用 400/403/404/405/413/415/503 等状态码。目录与包不可读或校验失败返回 503，不泄露服务端路径。文件大小上限：目录 2 MB、500 个版本，包 41 MB；拒绝符号链接包、越界文件名及摘要不一致。没有 POST 安装或授权接口。

```sh
curl -fsS http://127.0.0.1:5499/health
curl -fsS 'http://127.0.0.1:5499/api/plugins?category=tool'
curl -fsS http://127.0.0.1:5499/api/plugins/shanlian/versions
curl -fsS http://127.0.0.1:5499/catalog.json
```

工作台固定插件「自定义插件」可配置 HTTP 或 MCP（Streamable HTTP）市场连接。远端使用 HTTPS；本机 HTTP 只允许明确回环地址。宿主不会嵌入远端市场网页，不跟随重定向，安装与实际能力授权仍在本机完成。管理前端 dist 不含发布目录，市场服务继续从 releases 提供唯一目录。宿主暂不开放 stdio 启动命令，服务的 stdio 入口仍可供其他 MCP 客户端使用。

## MCP

HTTP MCP 客户端连接 `http://127.0.0.1:5499/mcp`。支持初始化、工具发现/调用及资源读取，采用官方 SDK 的 Streamable HTTP；不使用旧 SSE 协议。

stdio 配置示例（替换实际绝对路径）：

```json
{
  "mcpServers": {
    "plugin-market": {
      "command": "node",
      "args": ["/absolute/path/to/delivery-plugin-center/server/index.mjs", "--transport", "mcp"]
    }
  }
}
```

stdio 模式不监听端口，stdout 专供协议消息。四个工具均为只读：

| 工具 | 参数与结果 |
| --- | --- |
| `market_search` | query/category/offset/limit；返回 total/items |
| `market_detail` | id、可选 version；返回发布声明和包元数据 |
| `market_versions` | id；返回版本列表 |
| `market_package` | id、可选 version；校验包后返回 sha256、size、resourceUri；有 HTTP 地址时附 downloadUrl |

资源 `plugin-market://catalog` 返回 JSON；`plugin-market://packages/{name}` 返回 Base64 包内容。大包建议走 HTTP 下载，避免将整个包内容带入对话上下文。不存在的插件或校验失败以工具 `isError` 或资源协议错误返回，不伪造成功。

SDK 固定为 `@modelcontextprotocol/sdk@1.32.2`，参照 [官方 v1 服务端文档](https://ts.sdk.modelcontextprotocol.io/server)。

## 验证与发布

```sh
pnpm test
pnpm build
```

服务测试使用临时目录、随机端口和官方 MCP 客户端，覆盖 HTTP、Streamable HTTP、stdio、版本查询、下载摘要、错误及默认启动/退出。测试不修改真实安装记录或调用外部业务。`pnpm build` 构建管理前端；服务入口是仓库的 `server/index.mjs`，部署服务需同时提供 package.json、锁文件、vendor SDK、server、releases 并安装运行依赖，不要只复制前端 dist。
