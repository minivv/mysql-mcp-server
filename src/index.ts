#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import mysql from 'mysql2/promise';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import { exec } from 'child_process';
import { getHtmlPage } from './web-ui.js';

// Web server port
const WEB_PORT = parseInt(process.env.MCP_WEB_PORT || '3456', 10);

// Configuration file path
const CONFIG_DIR = path.join(os.homedir(), '.mysql-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'connections.json');
const KEY_FILE = path.join(CONFIG_DIR, '.key');
const PERMISSIONS_FILE = path.join(CONFIG_DIR, 'permissions.json');

// Encryption utilities
const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  if (fs.existsSync(KEY_FILE)) {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8'), 'hex');
  }
  const key = randomBytes(32);
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encryptPassword(password: string): string {
  if (!password) return '';
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptPassword(encryptedData: string): string {
  if (!encryptedData || !encryptedData.includes(':')) return encryptedData;
  try {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return encryptedData;
  }
}

// 库环境标识：测试库 / 正式库。权限模板绑定在这个标识上。
type DbEnv = 'test' | 'prod';

// 受权限控制的写操作类型。SELECT 等只读查询始终放开，不受开关限制。
type Operation = 'ddl' | 'insert' | 'update' | 'delete';

type PermissionTemplate = Record<Operation, boolean>;

interface DbConnection {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  env: DbEnv;
}

interface ConnectionsConfig {
  connections: DbConnection[];
  activeConnection: string | null;
}

// 权限模板：按环境标识绑定，改一次所有同标识的库一起生效
type PermissionsConfig = Record<DbEnv, PermissionTemplate>;

const DEFAULT_PERMISSIONS: PermissionsConfig = {
  test: { ddl: true, insert: true, update: true, delete: true },
  prod: { ddl: false, insert: false, update: false, delete: false },
};

const ENV_LABEL: Record<DbEnv, string> = { test: '测试库', prod: '正式库' };

const OPERATION_LABEL: Record<Operation, string> = {
  ddl: 'DDL（CREATE / ALTER / DROP / TRUNCATE / RENAME）',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
};

const normalizeEnv = (env: unknown): DbEnv => (env === 'test' ? 'test' : 'prod');

// Load configuration from file (with password decryption)
function loadConfig(): ConnectionsConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(data) as ConnectionsConfig;
      config.connections = config.connections.map(conn => ({
        ...conn,
        password: decryptPassword(conn.password),
        // 历史配置没有 env 字段时按正式库处理，宁可保守
        env: normalizeEnv(conn.env),
      }));
      return config;
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return { connections: [], activeConnection: null };
}

// Save configuration to file (with password encryption)
function saveConfig(config: ConnectionsConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const configToSave: ConnectionsConfig = {
      ...config,
      connections: config.connections.map(conn => ({
        ...conn,
        password: encryptPassword(conn.password),
      })),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
  } catch (error) {
    console.error('Error saving config:', error);
  }
}

// 读取权限模板配置
function loadPermissions(): PermissionsConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(PERMISSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8')) as Partial<PermissionsConfig>;
      return {
        test: { ...DEFAULT_PERMISSIONS.test, ...(data.test || {}) },
        prod: { ...DEFAULT_PERMISSIONS.prod, ...(data.prod || {}) },
      };
    }
  } catch (error) {
    console.error('Error loading permissions:', error);
  }
  return {
    test: { ...DEFAULT_PERMISSIONS.test },
    prod: { ...DEFAULT_PERMISSIONS.prod },
  };
}

// 保存权限模板配置
function savePermissions(config: PermissionsConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(config, null, 2));
}

// 取指定环境标识生效的权限模板
function getPermissionTemplate(env: DbEnv): PermissionTemplate {
  return loadPermissions()[env];
}

const NO_ACTIVE_CONNECTION_MESSAGE =
  'No active MySQL connection. Open the Web UI, save a connection, and click Use before running database tools.';

// Get current connection config
function getCurrentConnection(): DbConnection | null {
  const config = loadConfig();
  if (config.activeConnection) {
    const conn = config.connections.find(c => c.name === config.activeConnection);
    if (conn) return conn;
  }

  const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, MYSQL_ENV } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER) {
    return null;
  }

  // Optional legacy fallback from environment variables.
  return {
    name: 'default',
    host: MYSQL_HOST,
    port: parseInt(MYSQL_PORT || '3306', 10),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD || '',
    database: MYSQL_DATABASE || '',
    // 环境变量方式接入时默认也按正式库处理
    env: normalizeEnv(MYSQL_ENV),
  };
}

// Validate SQL query arguments
const isValidSqlQueryArgs = (args: unknown): args is { query: string } =>
  typeof args === 'object' &&
  args !== null &&
  typeof (args as { query?: unknown }).query === 'string';

// 去掉语句开头的空白与注释，避免用 "/* x */ drop table" 绕开首关键字判断
const stripLeadingComments = (query: string): string =>
  query.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|#[^\n]*(\n|$)))+/, '').trim();

const firstKeyword = (query: string): string =>
  (stripLeadingComments(query).match(/^([a-zA-Z]+)/)?.[1] || '').toLowerCase();

const READ_ONLY_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'explain']);

interface StatementKind {
  read: boolean;
  op: Operation | null;
  keyword: string;
}

// 语句归类：只读 / DDL / INSERT / UPDATE / DELETE
function classifyStatement(query: string): StatementKind {
  const stripped = stripLeadingComments(query);
  const keyword = firstKeyword(query);

  // WITH ... 可能是只读 CTE，也可能是 CTE 包裹的写语句，需要再看动词
  if (keyword === 'with') {
    const writeMatch = stripped.match(/\b(insert|replace|update|delete)\b/i);
    if (writeMatch) {
      const verb = writeMatch[1].toLowerCase();
      // 关键字报实际写动词（例如 WITH ... DELETE 报 DELETE），便于定位
      return { read: false, op: verb === 'replace' ? 'insert' : (verb as Operation), keyword: verb };
    }
    return { read: true, op: null, keyword };
  }

  if (READ_ONLY_KEYWORDS.has(keyword)) {
    return { read: true, op: null, keyword };
  }

  if (keyword === 'insert' || keyword === 'replace') {
    return { read: false, op: 'insert', keyword };
  }
  if (keyword === 'update') {
    return { read: false, op: 'update', keyword };
  }
  if (keyword === 'delete') {
    return { read: false, op: 'delete', keyword };
  }

  // CREATE / ALTER / DROP / TRUNCATE / RENAME 及一切未识别语句统一按 DDL 处理（最严格）
  return { read: false, op: 'ddl', keyword: keyword || '(empty)' };
}

// 查询结果行数上限，避免大表查询撑爆上下文
const DEFAULT_MAX_ROWS = 500;

const normalizeMaxRows = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ROWS;
  return Math.min(Math.floor(n), 10000);
};

// SHOW TABLES / SHOW DATABASES 返回 [{Tables_in_x: 'a'}]，压平成字符串数组
const flattenFirstColumn = (rows: unknown): string[] => {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => String(Object.values(row as Record<string, unknown>)[0]));
};

const generateTransactionId = (): string => randomUUID();

// mysql2 在连接失败时会抛 message 为空的 AggregateError，需要逐层拆出真实原因
const describeError = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const err = error as { message?: string; name?: string; code?: string; errors?: unknown[] };
    if (Array.isArray(err.errors) && err.errors.length > 0) {
      const nested = err.errors.map(describeError).filter(Boolean).join('; ');
      if (nested) return nested;
    }
    if (err.message) return err.code ? `${err.message} (${err.code})` : err.message;
    if (err.code) return err.name && err.name !== 'Error' ? `${err.name}: ${err.code}` : err.code;
    if (err.name && err.name !== 'Error') return err.name;
  }
  return String(error || 'Tool execution failed');
};

class MySqlServer {
  private server: Server;
  private pool: mysql.Pool | null = null;
  private currentDatabase: string = '';

  constructor() {
    this.server = new Server(
      { name: 'mysql-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    this.initializePool();
    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      if (this.pool) await this.pool.end();
      await this.server.close();
      process.exit(0);
    });
  }

  private initializePool() {
    const conn = getCurrentConnection();
    if (!conn) {
      console.error('No active MySQL connection configured. Use the Web UI to add and activate one.');
      return;
    }
    this.currentDatabase = conn.database;
    this.pool = mysql.createPool({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // 显式关闭多语句，避免一条参数里塞进多条 SQL
      multipleStatements: false,
      // 日期按字符串返回，避免时区转换带来的意外
      dateStrings: true,
    });
  }

  private requirePool(): mysql.Pool {
    if (!this.pool) {
      throw new McpError(ErrorCode.InvalidRequest, NO_ACTIVE_CONNECTION_MESSAGE);
    }
    return this.pool;
  }

  private async closePool() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.currentDatabase = '';
  }

  private async recreatePool(config: DbConnection) {
    await this.closePool();
    this.currentDatabase = config.database;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // 显式关闭多语句，避免一条参数里塞进多条 SQL
      multipleStatements: false,
      // 日期按字符串返回，避免时区转换带来的意外
      dateStrings: true,
    });
  }

  // 公开方法供 Web 服务器调用
  public async switchConnection(config: DbConnection) {
    await this.recreatePool(config);
    console.error(`[Web] Switched to connection: ${config.name}`);
  }

  public async clearConnection() {
    await this.closePool();
    console.error('[Web] Cleared active MySQL connection');
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getToolDefinitions(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const transactionId = generateTransactionId();
      console.error(`[${transactionId}] Processing: ${request.params.name}`);
      return this.handleToolCall(request, transactionId);
    });
  }

  private getToolDefinitions() {
    return [
      {
        name: 'run_sql_query',
        description: '执行只读 SQL（SELECT / SHOW / DESCRIBE / EXPLAIN / WITH），不受库环境权限限制',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL 查询语句' },
            max_rows: {
              type: 'number',
              description: `最多返回的行数，默认 ${DEFAULT_MAX_ROWS}`,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'execute_sql',
        description: '执行写操作 SQL（INSERT / UPDATE / DELETE / DDL）。是否允许取决于当前连接所属库环境标识（测试库 / 正式库）的权限模板',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL 语句' },
          },
          required: ['query'],
        },
      },
      {
        name: 'inspect',
        description: '查看库结构：不带参数返回库列表 + 当前库的表；传 database 返回该库的表；传 table（可配合 database）返回表结构',
        inputSchema: {
          type: 'object',
          properties: {
            database: { type: 'string', description: '数据库名，可选' },
            table: { type: 'string', description: '表名，可选' },
          },
        },
      },
      {
        name: 'switch_database',
        description: '切换当前使用的数据库',
        inputSchema: {
          type: 'object',
          properties: {
            database: { type: 'string', description: '数据库名' },
          },
          required: ['database'],
        },
      },
    ];
  }

  private async handleToolCall(request: any, transactionId: string) {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'run_sql_query':
          return await this.handleReadQuery(args, transactionId);
        case 'execute_sql':
          return await this.handleExecuteSql(args, transactionId);
        case 'inspect':
          return await this.handleInspect(args, transactionId);
        case 'switch_database':
          return await this.handleSwitchDatabase(args, transactionId);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      return this.errorResponse(error);
    }
  }

  private successResponse(data: unknown) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  private errorResponse(error: unknown) {
    return {
      content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
      isError: true,
    };
  }

  // Tool handlers
  // 取当前连接（含环境标识），没有连接时直接报错
  private requireConnection(): DbConnection {
    const conn = getCurrentConnection();
    if (!conn) {
      throw new McpError(ErrorCode.InvalidRequest, NO_ACTIVE_CONNECTION_MESSAGE);
    }
    return conn;
  }

  // 按当前连接的环境标识检查该项写操作是否被允许
  private checkPermission(kind: StatementKind): void {
    if (kind.read || !kind.op) return;

    const env = this.requireConnection().env;
    const template = getPermissionTemplate(env);

    if (!template[kind.op]) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${ENV_LABEL[env]}（env=${env}）不允许 ${OPERATION_LABEL[kind.op]} 操作，` +
        `已拦截关键字 "${kind.keyword.toUpperCase()}"。` +
        `如需放开，请到 Web UI 的「权限配置」中调整该标识对应的模板。`
      );
    }
  }

  private async handleReadQuery(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    const kind = classifyStatement(query);

    if (!kind.read) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `run_sql_query 只接受 SELECT / SHOW / DESCRIBE / EXPLAIN / 只读 WITH 查询，` +
        `检测到 "${kind.keyword.toUpperCase()}" 写操作，请改用 execute_sql。`
      );
    }

    const maxRows = normalizeMaxRows((args as { max_rows?: unknown }).max_rows);
    console.error(`[${transactionId}] Executing: ${query}`);
    const [rows] = await this.requirePool().query(query);
    const list = Array.isArray(rows) ? rows : [rows];
    const truncated = list.length > maxRows;

    return this.successResponse({
      rowCount: list.length,
      truncated,
      maxRows,
      rows: truncated ? list.slice(0, maxRows) : list,
    });
  }

  private async handleExecuteSql(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    const kind = classifyStatement(query);

    this.checkPermission(kind);

    console.error(`[${transactionId}] Executing (${kind.read ? 'read' : kind.op}): ${query}`);
    const [result] = await this.requirePool().query(query);
    return this.successResponse({
      success: true,
      operation: kind.read ? 'read' : kind.op,
      result,
    });
  }

  private async handleInspect(args: unknown, transactionId: string) {
    const { database, table } = (args || {}) as { database?: string; table?: string };
    const conn = this.requireConnection();
    const currentDatabase = this.currentDatabase || conn.database || '';
    const pool = this.requirePool();

    // 指定表：返回表结构
    if (table) {
      const target = database
        ? `${mysql.escapeId(database)}.${mysql.escapeId(table)}`
        : mysql.escapeId(table);
      console.error(`[${transactionId}] Inspecting table: ${target}`);
      const [columns] = await pool.query(`DESCRIBE ${target}`);
      return this.successResponse({
        env: conn.env,
        database: database || currentDatabase,
        table,
        columns,
      });
    }

    // 只指定库：返回该库的表列表
    if (database) {
      console.error(`[${transactionId}] Inspecting database: ${database}`);
      const [rows] = await pool.query(`SHOW TABLES FROM ${mysql.escapeId(database)}`);
      return this.successResponse({
        env: conn.env,
        database,
        tables: flattenFirstColumn(rows),
      });
    }

    // 都不指定：库列表 + 当前库的表
    console.error(`[${transactionId}] Inspecting current database: ${currentDatabase}`);
    const [dbRows] = await pool.query('SHOW DATABASES');
    let tables: string[] = [];
    if (currentDatabase) {
      const [tableRows] = await pool.query(`SHOW TABLES FROM ${mysql.escapeId(currentDatabase)}`);
      tables = flattenFirstColumn(tableRows);
    }
    return this.successResponse({
      env: conn.env,
      database: currentDatabase,
      databases: flattenFirstColumn(dbRows),
      tables,
    });
  }

  private async handleSwitchDatabase(args: unknown, transactionId: string) {
    const { database } = (args || {}) as { database?: string };
    if (!database) {
      throw new McpError(ErrorCode.InvalidParams, 'Database name required');
    }
    console.error(`[${transactionId}] Switching to database: ${database}`);
    await this.requirePool().query(`USE ${mysql.escapeId(database)}`);
    this.currentDatabase = database;
    return this.successResponse({
      success: true,
      message: `Switched to database: ${database}`,
      currentDatabase: database,
    });
  }


  async run() {
    if (process.env.MCP_WEB_UI !== 'false') {
      // Start web server with reference to this instance
      startWebServer(this);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP server v2.0.0 running on stdio');
  }
}

// Track if browser was opened
let browserOpened = false;

// Open browser (only once)
function openBrowser(url: string) {
  if (browserOpened) return;
  browserOpened = true;

  const platform = process.platform;
  let cmd: string;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err);
  });
}

// Web server
function startWebServer(mcpServer: MySqlServer) {
  const app = express();
  app.use(express.json());

  app.get('/api/connections', (_req, res) => {
    const config = loadConfig();
    const connections = config.connections.map(c => ({
      name: c.name,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      env: c.env,
      active: c.name === config.activeConnection,
    }));
    res.json({ connections, activeConnection: config.activeConnection });
  });

  app.post('/api/connections', (req, res) => {
    const { name, host, port, user, password, database, env } = req.body || {};
    if (!name || !host || !user) {
      return res.status(400).json({ error: 'name、host、user 为必填项' });
    }
    const config = loadConfig();
    const idx = config.connections.findIndex(c => c.name === name);
    const existing = idx >= 0 ? config.connections[idx] : null;
    const conn: DbConnection = {
      name,
      host,
      port: Number(port) || 3306,
      user,
      // 编辑时留空表示沿用原密码
      password: password ? String(password) : (existing?.password || ''),
      database: database || '',
      env: normalizeEnv(env),
    };
    if (idx >= 0) config.connections[idx] = conn;
    else config.connections.push(conn);
    saveConfig(config);
    res.json({ success: true, env: conn.env });
  });

  app.delete('/api/connections/:name', async (req, res) => {
    const { name } = req.params;
    const config = loadConfig();
    const idx = config.connections.findIndex(c => c.name === name);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const wasActive = config.activeConnection === name;
    config.connections.splice(idx, 1);
    if (wasActive) config.activeConnection = null;
    saveConfig(config);
    if (wasActive) await mcpServer.clearConnection();
    res.json({ success: true });
  });

  app.post('/api/connections/:name/activate', async (req, res) => {
    const { name } = req.params;
    const config = loadConfig();
    const conn = config.connections.find(c => c.name === name);
    if (!conn) {
      return res.status(404).json({ error: 'Not found' });
    }
    config.activeConnection = name;
    saveConfig(config);
    // 立即切换 MCP 服务器的连接池
    await mcpServer.switchConnection(conn);
    res.json({ success: true, env: conn.env });
  });

  app.post('/api/connections/test', async (req, res) => {
    const { host, port, user, password, database, name } = req.body || {};
    let resolvedPassword = password;
    // 编辑已有连接时前端不回显密码，此时用已保存的密码测试
    if ((!resolvedPassword || resolvedPassword === '') && name) {
      const saved = loadConfig().connections.find(c => c.name === name);
      resolvedPassword = saved?.password;
    }
    try {
      const conn = await mysql.createConnection({
        host, port: Number(port) || 3306, user, password: resolvedPassword, database,
      });
      await conn.query('SELECT 1');
      await conn.end();
      res.json({ success: true, message: '连接成功' });
    } catch (e: any) {
      res.json({ success: false, message: e.message });
    }
  });

  // 权限模板：按环境标识（test / prod）配置
  app.get('/api/permissions', (_req, res) => {
    res.json(loadPermissions());
  });

  app.put('/api/permissions', (req, res) => {
    const body = req.body || {};
    const pick = (template: any): PermissionTemplate => ({
      ddl: !!template?.ddl,
      insert: !!template?.insert,
      update: !!template?.update,
      delete: !!template?.delete,
    });
    const next: PermissionsConfig = { test: pick(body.test), prod: pick(body.prod) };
    savePermissions(next);
    res.json({ success: true, permissions: next });
  });

  app.get('/', (_req, res) => res.send(getHtmlPage()));

  const server = app.listen(WEB_PORT)
    .on('listening', () => {
      console.error(`Web UI: http://localhost:${WEB_PORT}`);
      if (process.env.MCP_OPEN_BROWSER !== 'false') {
        openBrowser(`http://localhost:${WEB_PORT}`);
      }
    })
    .on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Web UI] Port ${WEB_PORT} is already in use. Set MCP_WEB_PORT to use a different port.`);
      } else {
        console.error('Web server error:', err);
      }
    });
}

const server = new MySqlServer();
server.run().catch(console.error);
