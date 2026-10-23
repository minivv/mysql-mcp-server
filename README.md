# MySQL MCP Server

[English](#english) | [中文](#中文)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

---

<a name="english"></a>
## English

A powerful MySQL MCP (Model Context Protocol) server that enables AI assistants like Claude to interact with MySQL databases.

### Why This MCP Server?

Unlike other MySQL MCP servers, this project offers:

- **Web Management UI** - Visual interface to manage all your database connections
- **Real-time Connection Switching** - Switch between databases instantly without restarting
- **Smart Config Parsing** - Paste JDBC URL or Spring Boot config, auto-fill connection form
- **Secure Password Storage** - AES-256-GCM encrypted passwords
- **Environment-aware Permissions** - Tag each connection as test/prod; prod is read-only by default

### Screenshots

<!-- Add your screenshots here -->
![Web UI](images/web-ui-en.png)

### Acknowledgments

This project is inspired by and built upon [designcomputer/mysql_mcp_server](https://github.com/designcomputer/mysql_mcp_server). Special thanks to the original authors for their excellent work.

### Features

- **4 Focused Tools**: `run_sql_query`, `execute_sql`, `inspect`, `switch_database`
- **Environment Permissions**: per-connection `test` / `prod` tag, write operations gated by a shared template per tag (`prod` defaults to read-only)
- **Web UI**: Visual interface at `http://localhost:3456`
- **Secure Storage**: Passwords encrypted with AES-256-GCM
- **MCP Compatible**: Works with Claude Desktop and other MCP clients

### Installation

```bash
git clone https://github.com/minivv/mysql-mcp-server.git
cd mysql-mcp-server
npm install
npm run build
```

### Configuration

The server no longer requires a default database connection in environment variables.
Start the MCP server, open the Web UI, then add and activate your MySQL connection there.
Connections are saved in `~/.mysql-mcp/connections.json`.

#### Optional Environment Variables

```bash
MCP_WEB_PORT=3456              # Web UI port (default: 3456)
MCP_OPEN_BROWSER=false         # Disable auto-open browser (default: true)

# Optional legacy default connection fallback.
# If no Web UI connection is active, MYSQL_HOST and MYSQL_USER can still be used.
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database
MYSQL_ENV=prod                 # test | prod, default: prod
MCP_WEB_UI=false               # Disable the Web UI server entirely
```

#### Claude Desktop Configuration

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/path/to/mysql-mcp-server/build/index.js"],
      "env": {
        "MCP_OPEN_BROWSER": "false"
      }
    }
  }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `run_sql_query` | Read-only SQL (SELECT / SHOW / DESCRIBE / EXPLAIN / read-only WITH). Always allowed. Supports `max_rows` (default 500, max 10000). |
| `execute_sql` | Any SQL statement. Whether it runs depends on the write permissions of the current connection's environment tag. |
| `inspect` | No args: database list + tables of the current database. With `database`: tables of that database. With `table`: table structure. |
| `switch_database` | Switch the current database. |

Connection management (add / edit / delete / activate / permission templates) lives in the Web UI, not in MCP tools — that keeps the tool surface small and keeps passwords out of the conversation.

Every tool response carries the environment block, so the assistant knows where it is **before** attempting a write:

```json
{ "env": "prod", "envLabel": "正式库", "readOnly": true, "allowedWrites": [] }
```

### Web UI

The Web UI starts automatically with the MCP server at `http://localhost:3456`.
On first launch, add a connection, tag it as test or prod, and click **Use** before running database tools.

**Tabs:**
- **Connections** — add/edit/delete connections, test connectivity, one-click switch, env tag per connection, optional SSH tunnel, filter list by 全部 / 测试库 / 正式库
- **Permissions** — five switches (Basic DDL / Advanced DDL / INSERT / UPDATE / DELETE) per env tag (`test`, `prod`)

**Disable auto-open browser:**
```bash
MCP_OPEN_BROWSER=false
```

### SSH Tunnels

If MySQL is only reachable from a jump host (private network / VPN-only), enable **SSH tunnel** on that connection. The server spawns `ssh -N -L` itself and reuses the tunnel for the lifetime of the connection pool.

- **SSH host** — an alias from `~/.ssh/config` (e.g. `ssh66`), or an explicit `host` / `user` pair
- **Key file / passphrase** — optional; a passphrase is stored encrypted (AES-256-GCM) and fed to `ssh` through an ephemeral `SSH_ASKPASS` helper
- The connection's **host / port** then mean *"where MySQL listens as seen from the jump host"* (usually `127.0.0.1:3306`)
- Without a passphrase, auth runs in `BatchMode=yes` (no prompts); configure passwordless key auth first
- The local forwarding port is chosen automatically (starting from `13306`)
- Tunnels are torn down on connection switch / delete and on `SIGINT` / `SIGTERM`

```bash
# Pre-check: key auth must work without prompting
ssh -o BatchMode=yes <ssh-alias> echo OK
```

### Security

- Passwords are encrypted using AES-256-GCM
- Encryption key stored in `~/.mysql-mcp/.key` (mode 0600)
- Connection configs stored in `~/.mysql-mcp/connections.json`
- Dangerous-statement interception is a **guardrail, not a security boundary** — use a least-privilege MySQL account as the real boundary.

### Environment Permissions

Every connection carries an environment tag: `test` or `prod`. Permissions are bound to the **tag**, not the connection: change a template once and every connection with that tag follows immediately.

| Operation | Statements | Default `test` | Default `prod` |
|-----------|------------|:--------------:|:--------------:|
| Basic DDL | CREATE / RENAME / ALTER (without DROP) | ✅ | ❌ |
| Advanced DDL | DROP / TRUNCATE / ALTER … DROP | ✅ | ❌ |
| INSERT | INSERT / REPLACE | ✅ | ❌ |
| UPDATE | UPDATE | ✅ | ❌ |
| DELETE | DELETE | ✅ | ❌ |
| Read | SELECT / SHOW / DESCRIBE / EXPLAIN / read-only WITH | ✅ | ✅ |

Read-only statements are never gated. Anything that cannot be classified is treated as advanced DDL and blocked on `prod`. Statements are normalised first (leading `--` / `/* */` / `#` comments are stripped, `WITH … DELETE` is detected as a write), so `/* x */ DELETE …` does not slip through.

**Configuration file:** `~/.mysql-mcp/permissions.json` (managed by the Web UI). Configs written before the DDL split are migrated automatically (`ddl` maps to both DDL switches).

```json
{
  "test": { "basicDdl": true, "advancedDdl": true, "insert": true, "update": true, "delete": true },
  "prod": { "basicDdl": false, "advancedDdl": false, "insert": false, "update": false, "delete": false }
}
```

### Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### License

MIT License - see [LICENSE](LICENSE) for details.

---

<a name="中文"></a>
## 中文

一个功能强大的 MySQL MCP (Model Context Protocol) 服务器，让 Claude 等 AI 助手能够与 MySQL 数据库进行交互。

### 为什么选择这个 MCP 服务器？

与其他 MySQL MCP 服务器不同，本项目提供：

- **Web 管理界面** - 可视化管理所有数据库连接
- **实时切换连接** - 无需重启即可在不同数据库间切换
- **智能配置解析** - 粘贴 JDBC URL 或 Spring Boot 配置，自动填充表单
- **安全密码存储** - 使用 AES-256-GCM 加密存储密码
- **库环境权限** - 每个连接标记测试库/正式库，正式库默认只读

### 截图

<!-- 在此添加截图 -->
![Web 管理界面](images/web-ui-cn.png)

### 致谢

本项目基于 [designcomputer/mysql_mcp_server](https://github.com/designcomputer/mysql_mcp_server) 开发，特别感谢原作者的优秀工作。

### 功能特性

- **4 个精简工具**: `run_sql_query`、`execute_sql`、`inspect`、`switch_database`
- **库环境权限**: 每个连接带 `test` / `prod` 标识，写操作按标识套用共享权限模板（正式库默认只读）
- **Web 界面**: 可视化管理界面 `http://localhost:3456`
- **安全存储**: 密码使用 AES-256-GCM 加密
- **MCP 兼容**: 支持 Claude Desktop 和其他 MCP 客户端

### 安装

```bash
git clone https://github.com/minivv/mysql-mcp-server.git
cd mysql-mcp-server
npm install
npm run build
```

### 配置

现在不再需要通过环境变量配置默认数据库连接。
启动 MCP 服务器后，打开 Web 界面，在页面中添加并启用 MySQL 连接即可。
连接配置会保存到 `~/.mysql-mcp/connections.json`。

#### 可选环境变量

```bash
MCP_WEB_PORT=3456              # Web 界面端口 (默认: 3456)
MCP_OPEN_BROWSER=false         # 禁用自动打开浏览器 (默认: true)

# 可选：兼容旧版默认连接配置。
# 如果 Web 界面中没有启用连接，仍可通过 MYSQL_HOST 和 MYSQL_USER 提供默认连接。
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database
MYSQL_ENV=prod                 # test | prod，默认 prod
MCP_WEB_UI=false               # 完全关闭 Web 服务
```

#### Claude Desktop 配置

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/path/to/mysql-mcp-server/build/index.js"],
      "env": {
        "MCP_OPEN_BROWSER": "false"
      }
    }
  }
}
```

### 可用工具

| 工具 | 描述 |
|------|------|
| `run_sql_query` | 只读 SQL（SELECT / SHOW / DESCRIBE / EXPLAIN / 只读 WITH），永不受权限拦截。支持 `max_rows`（默认 500，上限 10000）。 |
| `execute_sql` | 执行任意 SQL，是否放行取决于当前连接所属库环境标识的写权限模板。 |
| `inspect` | 无参数：库列表 + 当前库的表；传 `database`：该库的表；传 `table`：表结构。 |
| `switch_database` | 切换当前数据库。 |

连接管理（新增/编辑/删除/启用/权限模板）全部在 Web 界面完成，不占用 MCP 工具位，也避免密码穿进对话。

每个工具的返回都带库环境信息，AI 在尝试写操作**之前**就知道自己在哪：

```json
{ "env": "prod", "envLabel": "正式库", "readOnly": true, "allowedWrites": [] }
```

### Web 管理界面

Web 界面随 MCP 服务器自动启动，访问 `http://localhost:3456`。
首次启动时，先添加连接、选择测试库/正式库标识，点击**使用**后再运行数据库工具。

**两个标签页：**
- **连接管理** — 新增/编辑/删除连接、测试连通性、一键切换、设置库环境标识、可选 SSH 隧道，列表可按 全部 / 测试库 / 正式库 筛选
- **权限配置** — 按标识（测试库 / 正式库）分别控制基础 DDL / 高级 DDL / INSERT / UPDATE / DELETE 五个开关

**禁用自动打开浏览器：**
```bash
MCP_OPEN_BROWSER=false
```

### SSH 隧道

如果 MySQL 只能从跳板机访问（内网 / 仅 VPN 可达），在该连接上开启 **SSH 隧道**。服务器会自己拉起 `ssh -N -L`，并在连接池生命周期内复用该隧道。

- **SSH 主机** — `~/.ssh/config` 里的别名（如 `ssh66`），或直接填 `host` / `user`
- **密钥文件 / 口令** — 可选；口令用 AES-256-GCM 加密存储，通过临时 `SSH_ASKPASS` 辅助脚本交给 `ssh`
- 连接里的 **主机 / 端口** 此时表示「从跳板机看到的 MySQL 地址」（通常 `127.0.0.1:3306`）
- 未填口令时走 `BatchMode=yes`（不弹交互提示），请先配好免密登录
- 本地转发端口自动选择（从 `13306` 起）
- 切换连接、删除连接、收到 `SIGINT` / `SIGTERM` 时自动关闭隧道

```bash
# 前置检查：密钥认证必须免密可用
ssh -o BatchMode=yes <ssh别名> echo OK
```

### 安全性

- 密码使用 AES-256-GCM 加密存储
- 加密密钥保存在 `~/.mysql-mcp/.key` (权限 0600)
- 连接配置保存在 `~/.mysql-mcp/connections.json`
- 语句拦截是**保险丝，不是安全边界**；真正的边界是最小权限的 MySQL 账号。

### 库环境权限

每个连接带一个环境标识：`test` 或 `prod`。权限绑在**标识**上而不是单个连接上：改一次模板，所有使用该标识的连接立即生效。

| 操作 | 对应语句 | 测试库默认 | 正式库默认 |
|------|----------|:----------:|:----------:|
| 基础 DDL | CREATE / RENAME / ALTER（不含 DROP） | ✅ | ❌ |
| 高级 DDL | DROP / TRUNCATE / ALTER … DROP | ✅ | ❌ |
| INSERT | INSERT / REPLACE | ✅ | ❌ |
| UPDATE | UPDATE | ✅ | ❌ |
| DELETE | DELETE | ✅ | ❌ |
| 只读 | SELECT / SHOW / DESCRIBE / EXPLAIN / 只读 WITH | ✅ | ✅ |

只读语句永不受限。无法识别的语句一律按高级 DDL 处理，在正式库上被拦截。判断前会先做归一化（剔除开头 `--`、`/* */`、`#` 注释，识别 `WITH … DELETE` 这类型写语句），所以 `/* x */ DELETE …` 无法绕过。

**配置文件：** `~/.mysql-mcp/permissions.json`（由 Web 界面维护）。拆分 DDL 之前的旧配置会自动迁移（`ddl` 同时映射到基础 / 高级 DDL）。

```json
{
  "test": { "basicDdl": true, "advancedDdl": true, "insert": true, "update": true, "delete": true },
  "prod": { "basicDdl": false, "advancedDdl": false, "insert": false, "update": false, "delete": false }
}
```

### 贡献

欢迎贡献代码！请随时提交 Pull Request。

### 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。
