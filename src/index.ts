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
import { spawn } from 'child_process';
import * as net from 'net';
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
type Operation = 'basicDdl' | 'advancedDdl' | 'insert' | 'update' | 'delete';

type PermissionTemplate = Record<Operation, boolean>;

// 需要 SSH 隧道才能进来的库（例如只在内网可达、或本机进程被拦在内网之外）
interface SshTunnelConfig {
  host: string;          // ssh 目标，可用 ~/.ssh/config 里的别名（如 ssh66）
  port?: number;         // ssh 端口，省略则用 ssh 默认/配置
  user?: string;         // ssh 用户
  keyFile?: string;      // 私钥文件路径
  passphrase?: string;   // 私钥口令（存盘时加密）
  remoteHost?: string;   // 从 ssh 主机看到的 MySQL 地址，默认用连接里的 host
  remotePort?: number;   // 从 ssh 主机看到的 MySQL 端口，默认用连接里的 port
}

interface DbConnection {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  env: DbEnv;
  ssh?: SshTunnelConfig | null;
}

interface ConnectionsConfig {
  connections: DbConnection[];
  activeConnection: string | null;
}

// 权限模板：按环境标识绑定，改一次所有同标识的库一起生效
type PermissionsConfig = Record<DbEnv, PermissionTemplate>;

const DEFAULT_PERMISSIONS: PermissionsConfig = {
  test: { basicDdl: true, advancedDdl: true, insert: true, update: true, delete: true },
  prod: { basicDdl: false, advancedDdl: false, insert: false, update: false, delete: false },
};

const ENV_LABEL: Record<DbEnv, string> = { test: '测试库', prod: '正式库' };

const OPERATION_LABEL: Record<Operation, string> = {
  basicDdl: '基础 DDL（CREATE / ALTER 加字段索引 / RENAME）',
  advancedDdl: '高级 DDL（DROP / TRUNCATE / ALTER DROP）',
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
        ssh: normalizeSsh(conn.ssh),
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
// 旧配置里的 ddl 开关同时控制基础 / 高级 DDL，做一次兼容迁移
function normalizeTemplate(raw: unknown, defaults: PermissionTemplate): PermissionTemplate {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const legacyDdl = typeof src.ddl === 'boolean' ? (src.ddl as boolean) : undefined;
  const pick = (key: Operation, fallback: boolean): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : fallback;
  return {
    basicDdl: pick('basicDdl', legacyDdl ?? defaults.basicDdl),
    advancedDdl: pick('advancedDdl', legacyDdl ?? defaults.advancedDdl),
    insert: pick('insert', defaults.insert),
    update: pick('update', defaults.update),
    delete: pick('delete', defaults.delete),
  };
}

function loadPermissions(): PermissionsConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(PERMISSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8')) as Partial<PermissionsConfig>;
      return {
        test: normalizeTemplate(data.test, DEFAULT_PERMISSIONS.test),
        prod: normalizeTemplate(data.prod, DEFAULT_PERMISSIONS.prod),
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

// 附在每次工具返回里的库环境摘要
interface EnvSummary {
  env: DbEnv;
  envLabel: string;
  readOnly: boolean;
  allowedWrites: Operation[];
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

  if (keyword === 'create') {
    return { read: false, op: 'basicDdl', keyword };
  }
  if (keyword === 'alter' || keyword === 'rename') {
    // ALTER TABLE ... DROP COLUMN 这类夹在 ALTER 里的破坏性操作按高级 DDL 处理
    const op: Operation = /\bdrop\b/i.test(stripped) ? 'advancedDdl' : 'basicDdl';
    return { read: false, op, keyword };
  }

  // DROP / TRUNCATE 以及一切未识别语句按高级 DDL 处理（最严格）
  return { read: false, op: 'advancedDdl', keyword: keyword || '(empty)' };
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

// ---------------------------------------------------------------------------
// SSH 隧道：部分内网库只能从跳板机访问（或被本机安全策略拦在内网之外），
// 这时由 MCP 自己拉起一条 ssh -L，MySQL 连 127.0.0.1 即可。
// ---------------------------------------------------------------------------
interface ActiveTunnel {
  proc: any;
  localPort: number;
}

const tunnels = new Map<string, ActiveTunnel>();

const normalizeSsh = (ssh: any): SshTunnelConfig | null => {
  if (!ssh || typeof ssh !== 'object' || !ssh.host) return null;
  const remotePort = Number(ssh.remotePort);
  const port = Number(ssh.port);
  return {
    host: String(ssh.host).trim(),
    ...(Number.isFinite(port) && port > 0 ? { port } : {}),
    ...(ssh.user ? { user: String(ssh.user).trim() } : {}),
    ...(ssh.keyFile ? { keyFile: String(ssh.keyFile).trim() } : {}),
    ...(ssh.passphrase ? { passphrase: String(ssh.passphrase) } : {}),
    ...(ssh.remoteHost ? { remoteHost: String(ssh.remoteHost).trim() } : {}),
    ...(Number.isFinite(remotePort) && remotePort > 0 ? { remotePort } : {}),
  };
};

const expandHome = (target: string): string =>
  target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;

// 私钥有口令时，用 SSH_ASKPASS 把口令喂给 ssh（-o BatchMode=yes 会禁用这条路径）
const writeAskpassScript = (passphrase: string): string => {
  const file = path.join(os.tmpdir(), `mysql-mcp-askpass-${randomUUID()}.sh`);
  const escaped = passphrase.replace(/'/g, `'\\''`);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${escaped}'\n`, { mode: 0o700 });
  return file;
};

const buildSshArgs = (ssh: SshTunnelConfig, localPort: number, remoteHost: string, remotePort: number): string[] => {
  const hasPassphrase = !!ssh.passphrase;
  const args = ['-N'];
  // 有口令时不能开 BatchMode，否则 ssh 根本不会去问 ASKPASS
  if (!hasPassphrase) args.push('-o', 'BatchMode=yes');
  args.push(
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    // 只绑回环，不对外暴露隧道端口
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
  );
  if (hasPassphrase) {
    args.push('-o', 'PreferredAuthentications=publickey', '-o', 'NumberOfPasswordPrompts=1');
  }
  if (ssh.keyFile) args.push('-i', expandHome(ssh.keyFile), '-o', 'IdentitiesOnly=yes');
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.user) args.push('-l', ssh.user);
  args.push(ssh.host);
  return args;
};

const findFreeLocalPort = async (start = 13306): Promise<number> => {
  const taken = new Set([...tunnels.values()].map(t => t.localPort));
  for (let port = start; port < start + 100; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('无法为 SSH 隧道分配本地端口');
};

const waitForPort = (port: number, timeoutMs = 8000): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`SSH 隧道端口 ${port} 未就绪`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });

// 返回 MySQL 实际应该连的 host / port（无 ssh 配置则原样返回）
const ensureTunnel = async (conn: DbConnection): Promise<{ host: string; port: number }> => {
  const ssh = normalizeSsh(conn.ssh);
  if (!ssh) return { host: conn.host, port: conn.port };

  // 远端地址默认就用连接里填的 host / port：跳板机通常能看到同一个内网库
  const remoteHost = ssh.remoteHost || conn.host;
  const remotePort = ssh.remotePort || conn.port;

  const running = tunnels.get(conn.name);
  if (running && running.proc.exitCode === null) {
    return { host: '127.0.0.1', port: running.localPort };
  }

  const localPort = await findFreeLocalPort();
  const passphrase = ssh.passphrase ? decryptPassword(ssh.passphrase) : '';
  const spawnOptions: { stdio: ['ignore', 'ignore', 'pipe']; env?: NodeJS.ProcessEnv } = { stdio: ['ignore', 'ignore', 'pipe'] };
  let askpassFile: string | null = null;
  if (passphrase) {
    askpassFile = writeAskpassScript(passphrase);
    spawnOptions.env = {
      ...process.env,
      SSH_ASKPASS: askpassFile,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
    };
  }
  const proc = spawn('ssh', buildSshArgs(ssh, localPort, remoteHost, remotePort), spawnOptions);
  if (askpassFile) {
    // ssh 认证一发生就会读完，留一点余量后删掉，避免口令长期躺在磁盘上
    setTimeout(() => {
      try { fs.unlinkSync(askpassFile as string); } catch { /* ignore */ }
    }, 15000);
  }
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = String(chunk).trim();
    if (text) console.error(`[SSH:${conn.name}] ${text}`);
  });
  proc.on('exit', (code: number | null) => {
    console.error(`[SSH:${conn.name}] tunnel exited (code=${code})`);
    tunnels.delete(conn.name);
  });

  tunnels.set(conn.name, { proc, localPort });
  try {
    await waitForPort(localPort);
  } catch (error) {
    killTunnel(conn.name);
    throw error;
  }

  console.error(`[SSH:${conn.name}] 127.0.0.1:${localPort} → ${ssh.host} → ${remoteHost}:${remotePort}`);
  return { host: '127.0.0.1', port: localPort };
};

const killTunnel = (name: string): void => {
  const tunnel = tunnels.get(name);
  if (!tunnel) return;
  try { tunnel.proc.kill(); } catch { /* ignore */ }
  tunnels.delete(name);
};

const closeTunnels = (): void => {
  for (const [name, tunnel] of tunnels) {
    try { tunnel.proc.kill(); } catch { /* ignore */ }
    console.error(`[SSH:${name}] tunnel closed`);
  }
  tunnels.clear();
};

class MySqlServer {
  private server: Server;
  private pool: mysql.Pool | null = null;
  private currentDatabase: string = '';
  // 当前连接池对应的配置签名，用来发现配置文件变更
  private poolSignature: string = '';
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.server = new Server(
      { name: 'mysql-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    // 建池可能要先拉起 SSH 隧道，所以是异步的，run() 里等它
    this.initPromise = this.initializePool().catch((error) => {
      console.error(`[init] ${describeError(error)}`);
    });
    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    const shutdown = async () => {
      closeTunnels();
      if (this.pool) await this.pool.end();
      await this.server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', closeTunnels);
  }

  private async initializePool() {
    const conn = getCurrentConnection();
    if (!conn) {
      console.error('No active MySQL connection configured. Use the Web UI to add and activate one.');
      return;
    }
    this.currentDatabase = conn.database;
    const { host, port } = await this.resolveTarget(conn);
    this.pool = mysql.createPool({
      host,
      port,
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
    this.poolSignature = this.connectionSignature(conn);
  }

  // 连接配置的特征串：名称 / 地址 / 账号 / 库 / 标识 / SSH 任一变化都要重建连接池
  private connectionSignature(conn: DbConnection): string {
    return JSON.stringify([
      conn.name,
      conn.host,
      conn.port,
      conn.user,
      conn.password,
      conn.database,
      conn.env,
      conn.ssh || null,
    ]);
  }

  // 配置可能被 Web UI 改过（该 Web UI 甚至可能属于另一个进程），每次工具调用前先对齐
  private async ensureActiveConnection(): Promise<void> {
    const conn = getCurrentConnection();
    if (!conn) {
      if (this.pool) {
        await this.closePool().catch(() => undefined);
      }
      return;
    }
    if (this.pool && this.connectionSignature(conn) === this.poolSignature) {
      return;
    }
    console.error(`[conn] 激活连接变更，重建连接池：${conn.name}（env=${conn.env}, db=${conn.database}）`);
    await this.recreatePool(conn);
  }
  private async resolveTarget(conn: DbConnection): Promise<{ host: string; port: number }> {
    try {
      return await ensureTunnel(conn);
    } catch (error) {
      console.error(`[SSH:${conn.name}] 隧道建立失败：${describeError(error)}`);
      throw new McpError(
        ErrorCode.InternalError,
        `连接「${conn.name}」的 SSH 隧道建立失败：${describeError(error)}。` +
        `请检查 ssh 是否免密可用（ssh ${normalizeSsh(conn.ssh)?.host || ''}）。`
      );
    }
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
    this.poolSignature = '';
  }

  private async recreatePool(config: DbConnection) {
    await this.closePool();
    this.currentDatabase = config.database;
    const { host, port } = await this.resolveTarget(config);
    this.pool = mysql.createPool({
      host,
      port,
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
    this.poolSignature = this.connectionSignature(config);
  }
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
        description: '执行只读 SQL（SELECT / SHOW / DESCRIBE / EXPLAIN / WITH），任何环境都允许。返回含 env（test=测试库 / prod=正式库）、readOnly、allowedWrites',
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
        description: '执行写操作 SQL（INSERT / UPDATE / DELETE / DDL）。是否放行取决于当前连接的库环境标识及权限模板，被拦截时会说明原因。返回含 env / readOnly / 执行结果',
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
        description: '查看库结构：不带参数返回库列表 + 当前库的表；传 database 返回该库的表；传 table（可配合 database）返回表结构。返回含 env / envLabel / readOnly / allowedWrites，可先用它确认当前库环境再决定能否写入',
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
        description: '切换当前使用的数据库（只换库，不会改变连接的测试库/正式库标识）',
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
      // 允许配置在别处（另一个进程的 Web UI / 手改 json）被更新，这里自动跟随
      await this.ensureActiveConnection();
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

  // 每个工具返回都带上库环境信息，让调用方知道自己在测试库还是正式库
  private envSummary(conn: DbConnection = this.requireConnection()): EnvSummary {
    const env = conn.env;
    const template = getPermissionTemplate(env);
    const allowedWrites = (Object.keys(template) as Operation[]).filter(op => template[op]);
    return {
      env,
      envLabel: ENV_LABEL[env],
      readOnly: allowedWrites.length === 0,
      allowedWrites,
    };
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
      ...this.envSummary(),
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
      ...this.envSummary(),
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
        ...this.envSummary(conn),
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
        ...this.envSummary(conn),
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
      ...this.envSummary(conn),
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
      ...this.envSummary(),
      success: true,
      message: `Switched to database: ${database}`,
      currentDatabase: database,
    });
  }


  async run() {
    // 等连接（含 SSH 隧道）就绪，避免客户端一开始就拿到「无活动连接」
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* 错误已在 resolveTarget 中说明 */ }
    }

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
      ssh: c.ssh
        ? {
            ...c.ssh,
            // 口令不对外回显，前端只需要知道“已设置”
            passphrase: undefined,
            hasPassphrase: !!c.ssh.passphrase,
          }
        : null,
      active: c.name === config.activeConnection,
    }));
    res.json({ connections, activeConnection: config.activeConnection });
  });

  app.post('/api/connections', (req, res) => {
    const { name, originalName, host, port, user, password, database, env, ssh } = req.body || {};
    if (!name || !host || !user) {
      return res.status(400).json({ error: 'name、host、user 为必填项' });
    }
    const config = loadConfig();
    // 编辑时前端会带原名称，改名后仍能定位到同一条连接
    const lookup = originalName || name;
    const idx = config.connections.findIndex(c => c.name === lookup);
    const existing = idx >= 0 ? config.connections[idx] : null;
    if (name !== lookup && config.connections.some(c => c.name === name)) {
      return res.status(400).json({ error: `连接名称「${name}」已存在` });
    }
    const conn: DbConnection = {
      name,
      host,
      port: Number(port) || 3306,
      user,
      // 编辑时留空表示沿用原密码
      password: password ? String(password) : (existing?.password || ''),
      database: database || '',
      env: normalizeEnv(env),
      ssh: (() => {
        const normalized = normalizeSsh(ssh);
        if (!normalized) return normalized;
        const input = typeof ssh.passphrase === 'string' ? ssh.passphrase.trim() : '';
        // 口令留空则沿用已保存的；否则加密后落盘
        const passphrase = input
          ? encryptPassword(input)
          : (existing?.ssh?.passphrase || undefined);
        return { ...normalized, ...(passphrase ? { passphrase } : {}) };
      })(),
    };
    if (idx >= 0) config.connections[idx] = conn;
    else config.connections.push(conn);
    // 改名时同步活动连接标记，避免指向已重命名的连接
    if (config.activeConnection === lookup && lookup !== name) {
      config.activeConnection = name;
    }
    // SSH 目标变了就把旧隧道断掉，下次使用重新拉起
    if (lookup !== name || JSON.stringify(existing?.ssh || null) !== JSON.stringify(conn.ssh || null)) {
      killTunnel(lookup);
    }
    saveConfig(config);
    res.json({ success: true, env: conn.env, name: conn.name, renamed: lookup !== name });
  });

  app.delete('/api/connections/:name', async (req, res) => {
    const { name } = req.params;
    const config = loadConfig();
    const idx = config.connections.findIndex(c => c.name === name);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const wasActive = config.activeConnection === name;
    config.connections.splice(idx, 1);
    if (wasActive) config.activeConnection = null;
    killTunnel(name);
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
    // 立即切换 MCP 服务器的连接池（可能要先拉 SSH 隧道，失败要回给前端）
    try {
      await mcpServer.switchConnection(conn);
      res.json({ success: true, env: conn.env });
    } catch (e) {
      res.status(500).json({ success: false, error: describeError(e) });
    }
  });

  app.post('/api/connections/test', async (req, res) => {
    const { host, port, user, password, database, name, originalName, ssh } = req.body || {};
    let resolvedPassword = password;
    // 编辑已有连接时前端不回显密码 / 口令，此时用已保存的
    const saved = (originalName || name)
      ? loadConfig().connections.find(c => c.name === (originalName || name))
      : undefined;
    if ((!resolvedPassword || resolvedPassword === '') && saved) {
      resolvedPassword = saved.password;
    }
    // 保存的密码是密文，测试前先解密
    resolvedPassword = resolvedPassword ? decryptPassword(resolvedPassword) : '';

    const normalizedSsh = normalizeSsh(ssh);
    const inputPassphrase = typeof ssh?.passphrase === 'string' ? ssh.passphrase.trim() : '';
    const testSsh = normalizedSsh
      ? {
          ...normalizedSsh,
          ...(inputPassphrase
            ? { passphrase: inputPassphrase }
            : (saved?.ssh?.passphrase ? { passphrase: saved.ssh.passphrase } : {})),
        }
      : null;

    // 有 SSH 配置时先拉起临时隧道，测完即拆
    const testKey = `__test__${randomUUID()}`;
    try {
      const target = await ensureTunnel({
        name: testKey,
        host,
        port: Number(port) || 3306,
        user,
        password: resolvedPassword,
        database: database || '',
        env: 'test',
        ssh: testSsh,
      });
      const conn = await mysql.createConnection({
        host: target.host, port: target.port, user, password: resolvedPassword, database,
      });
      await conn.query('SELECT 1');
      await conn.end();
      res.json({ success: true, message: '连接成功' });
    } catch (e: any) {
      res.json({ success: false, message: describeError(e) });
    } finally {
      killTunnel(testKey);
    }
  });

  // 给「选择私钥文件」用的极简目录浏览，范围限制在用户主目录内
  app.get('/api/files', (req, res) => {
    const home = os.homedir();
    const requested =
      typeof req.query.dir === 'string' && req.query.dir
        ? expandHome(req.query.dir)
        : path.join(home, '.ssh');
    const dir = path.resolve(requested);
    if (dir !== home && !dir.startsWith(home + path.sep)) {
      return res.status(400).json({ error: '只能浏览用户主目录下的文件' });
    }
    // 传进来的是文件（如已填好的私钥路径）时，退到它所在目录
    let listDir = dir;
    try {
      if (fs.statSync(dir).isFile()) listDir = path.dirname(dir);
    } catch { /* 路径不存在就按目录处理 */ }
    try {
      const entries = fs
        .readdirSync(listDir, { withFileTypes: true })
        .map(entry => ({
          name: entry.name,
          path: path.join(listDir, entry.name),
          dir: entry.isDirectory(),
        }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      res.json({ dir: listDir, parent: listDir === home ? null : path.dirname(listDir), home, entries });
    } catch (e) {
      res.status(400).json({ error: describeError(e) });
    }
  });

  // 权限模板：按环境标识（test / prod）配置
  app.get('/api/permissions', (_req, res) => {
    res.json(loadPermissions());
  });

  app.put('/api/permissions', (req, res) => {
    const body = req.body || {};
    const pick = (template: any): PermissionTemplate => ({
      basicDdl: !!template?.basicDdl,
      advancedDdl: !!template?.advancedDdl,
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
        console.error(
          `[Web UI] 端口 ${WEB_PORT} 已被占用（通常是另一个 MCP 实例在跑）。本实例不提供 Web UI，` +
          `但 MCP 工具照常可用，并会自动跟随配置文件里的激活连接变更。`
        );
      } else {
        console.error('Web server error:', err);
      }
    });
}

const server = new MySqlServer();
server.run().catch(console.error);
