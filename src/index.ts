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

// Web server port
const WEB_PORT = parseInt(process.env.MCP_WEB_PORT || '3456', 10);

// Configuration file path
const CONFIG_DIR = path.join(os.homedir(), '.mysql-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'connections.json');
const KEY_FILE = path.join(CONFIG_DIR, '.key');
const BLACKLIST_FILE = path.join(CONFIG_DIR, 'sql-blacklist.json');

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

// Database connection configuration interface
interface DbConnection {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// SQL Blacklist configuration interface
interface SqlBlacklistConfig {
  enabled: boolean;
  patterns: SqlBlacklistPattern[];
}

interface SqlBlacklistPattern {
  id: string;
  pattern: string;
  description: string;
  enabled: boolean;
}

interface ConnectionsConfig {
  connections: DbConnection[];
  activeConnection: string | null;
}

// Default SQL blacklist patterns
const DEFAULT_BLACKLIST_PATTERNS: SqlBlacklistPattern[] = [
  { id: '1', pattern: '^\\s*drop\\s+database', description: '禁止删除数据库 (DROP DATABASE)', enabled: true },
  { id: '2', pattern: '^\\s*drop\\s+table', description: '禁止删除表 (DROP TABLE)', enabled: true },
  { id: '3', pattern: '^\\s*drop\\s+index', description: '禁止删除索引 (DROP INDEX)', enabled: true },
  { id: '4', pattern: '^\\s*truncate', description: '禁止清空表 (TRUNCATE)', enabled: true },
  { id: '5', pattern: '^\\s*delete\\s+from\\s+\\S+\\s*$', description: '禁止无条件删除 (DELETE without WHERE)', enabled: true },
  { id: '6', pattern: '^\\s*update\\s+\\S+\\s+set\\s+.*(?<!where.*)$', description: '禁止无条件更新 (UPDATE without WHERE)', enabled: true },
  { id: '7', pattern: '^\\s*alter\\s+table\\s+\\S+\\s+drop', description: '禁止删除列 (ALTER TABLE DROP)', enabled: true },
  { id: '8', pattern: '^\\s*rename\\s+database', description: '禁止重命名数据库 (RENAME DATABASE)', enabled: true },
  { id: '9', pattern: '^\\s*grant\\s+', description: '禁止授权操作 (GRANT)', enabled: true },
  { id: '10', pattern: '^\\s*revoke\\s+', description: '禁止撤销权限 (REVOKE)', enabled: true },
];

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

// Load SQL blacklist configuration
function loadBlacklist(): SqlBlacklistConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = fs.readFileSync(BLACKLIST_FILE, 'utf-8');
      return JSON.parse(data) as SqlBlacklistConfig;
    }
  } catch (error) {
    console.error('Error loading blacklist:', error);
  }
  // Return default config
  return { enabled: true, patterns: DEFAULT_BLACKLIST_PATTERNS };
}

// Save SQL blacklist configuration
function saveBlacklist(config: SqlBlacklistConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving blacklist:', error);
  }
}

// Get current connection config
function getCurrentConnection(): DbConnection {
  const config = loadConfig();
  if (config.activeConnection) {
    const conn = config.connections.find(c => c.name === config.activeConnection);
    if (conn) return conn;
  }
  // Return default from environment variables
  return {
    name: 'default',
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || '',
  };
}

// Check if SQL query matches any blacklist pattern
function checkSqlBlacklist(query: string): { blocked: boolean; reason?: string } {
  const blacklist = loadBlacklist();
  if (!blacklist.enabled) {
    return { blocked: false };
  }

  const normalizedQuery = query.trim().toLowerCase();

  for (const pattern of blacklist.patterns) {
    if (!pattern.enabled) continue;
    try {
      const regex = new RegExp(pattern.pattern, 'i');
      if (regex.test(normalizedQuery)) {
        return { blocked: true, reason: pattern.description };
      }
    } catch (e) {
      console.error(`Invalid regex pattern: ${pattern.pattern}`, e);
    }
  }

  return { blocked: false };
}

// Validate SQL query arguments
const isValidSqlQueryArgs = (args: unknown): args is { query: string } =>
  typeof args === 'object' &&
  args !== null &&
  typeof (args as { query?: unknown }).query === 'string';

// Check if query is read-only
const isReadOnlyQuery = (query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  const readOnlyPrefixes = ['select', 'show', 'describe', 'desc', 'explain'];
  return readOnlyPrefixes.some(prefix => normalizedQuery.startsWith(prefix));
};

// Check query types
const isCreateTableQuery = (query: string): boolean =>
  query.trim().toLowerCase().startsWith('create table');

const isInsertQuery = (query: string): boolean =>
  query.trim().toLowerCase().startsWith('insert');

const isUpdateQuery = (query: string): boolean =>
  query.trim().toLowerCase().startsWith('update');

const isDeleteQuery = (query: string): boolean =>
  query.trim().toLowerCase().startsWith('delete');

const generateTransactionId = (): string => randomUUID();

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
    });
  }

  private async recreatePool(config: DbConnection) {
    if (this.pool) {
      await this.pool.end();
    }
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
    });
  }

  // 公开方法供 Web 服务器调用
  public async switchConnection(config: DbConnection) {
    await this.recreatePool(config);
    console.error(`[Web] Switched to connection: ${config.name}`);
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
        description: 'Execute read-only SQL (SELECT, SHOW, DESCRIBE, EXPLAIN)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL query to execute' },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_databases',
        description: 'List all available databases',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_tables',
        description: 'List all tables in current database',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'describe_table',
        description: 'Show table structure',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
          },
          required: ['table'],
        },
      },
      {
        name: 'switch_database',
        description: 'Switch to a different database',
        inputSchema: {
          type: 'object',
          properties: {
            database: { type: 'string', description: 'Database name' },
          },
          required: ['database'],
        },
      },
      {
        name: 'get_connection_info',
        description: 'Get current connection information',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_saved_connections',
        description: 'List all saved database connections',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'save_connection',
        description: 'Save a new database connection',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Connection name' },
            host: { type: 'string', description: 'MySQL host' },
            port: { type: 'number', description: 'MySQL port' },
            user: { type: 'string', description: 'MySQL user' },
            password: { type: 'string', description: 'MySQL password' },
            database: { type: 'string', description: 'Default database' },
          },
          required: ['name', 'host', 'user', 'password'],
        },
      },
      {
        name: 'use_connection',
        description: 'Switch to a saved connection',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Connection name' },
          },
          required: ['name'],
        },
      },
      {
        name: 'delete_connection',
        description: 'Delete a saved connection',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Connection name' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_table',
        description: 'Create a new table',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'CREATE TABLE query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'insert_data',
        description: 'Insert data into a table',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'INSERT query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'update_data',
        description: 'Update data in a table',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'UPDATE query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'delete_data',
        description: 'Delete data from a table',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'DELETE query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'execute_sql',
        description: 'Execute any SQL statement (ALTER, DROP, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL statement' },
          },
          required: ['query'],
        },
      },
    ];
  }

  private async handleToolCall(request: any, transactionId: string) {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'run_sql_query':
          return this.handleReadQuery(args, transactionId);
        case 'list_databases':
          return this.handleListDatabases(transactionId);
        case 'list_tables':
          return this.handleListTables(transactionId);
        case 'describe_table':
          return this.handleDescribeTable(args, transactionId);
        case 'switch_database':
          return this.handleSwitchDatabase(args, transactionId);
        case 'get_connection_info':
          return this.handleGetConnectionInfo();
        case 'list_saved_connections':
          return this.handleListConnections();
        case 'save_connection':
          return this.handleSaveConnection(args);
        case 'use_connection':
          return this.handleUseConnection(args);
        case 'delete_connection':
          return this.handleDeleteConnection(args);
        case 'create_table':
          return this.handleCreateTable(args, transactionId);
        case 'insert_data':
          return this.handleInsertData(args, transactionId);
        case 'update_data':
          return this.handleUpdateData(args, transactionId);
        case 'delete_data':
          return this.handleDeleteData(args, transactionId);
        case 'execute_sql':
          return this.handleExecuteSql(args, transactionId);
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }

  // Tool handlers
  private async handleReadQuery(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    if (!isReadOnlyQuery(query)) {
      throw new McpError(ErrorCode.InvalidParams,
        'Only SELECT, SHOW, DESCRIBE, EXPLAIN allowed');
    }
    console.error(`[${transactionId}] Executing: ${query}`);
    const [rows] = await this.pool!.query(query);
    return this.successResponse(rows);
  }

  private async handleListDatabases(transactionId: string) {
    console.error(`[${transactionId}] Listing databases`);
    const [rows] = await this.pool!.query('SHOW DATABASES');
    return this.successResponse(rows);
  }

  private async handleListTables(transactionId: string) {
    console.error(`[${transactionId}] Listing tables`);
    const [rows] = await this.pool!.query('SHOW TABLES');
    return this.successResponse({
      database: this.currentDatabase,
      tables: rows,
    });
  }

  private async handleDescribeTable(args: unknown, transactionId: string) {
    const { table } = args as { table: string };
    if (!table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name required');
    }
    console.error(`[${transactionId}] Describing table: ${table}`);
    const [rows] = await this.pool!.query(`DESCRIBE \`${table}\``);
    return this.successResponse(rows);
  }

  private async handleSwitchDatabase(args: unknown, transactionId: string) {
    const { database } = args as { database: string };
    if (!database) {
      throw new McpError(ErrorCode.InvalidParams, 'Database name required');
    }
    console.error(`[${transactionId}] Switching to database: ${database}`);
    await this.pool!.query(`USE \`${database}\``);
    this.currentDatabase = database;
    return this.successResponse({
      success: true,
      message: `Switched to database: ${database}`,
      currentDatabase: database,
    });
  }

  private handleGetConnectionInfo() {
    const conn = getCurrentConnection();
    return this.successResponse({
      name: conn.name,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      database: this.currentDatabase || conn.database,
    });
  }

  private handleListConnections() {
    const config = loadConfig();
    const connections = config.connections.map(c => ({
      name: c.name,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      active: c.name === config.activeConnection,
    }));
    return this.successResponse({ connections });
  }

  private handleSaveConnection(args: unknown) {
    const { name, host, port, user, password, database } = args as DbConnection;
    if (!name || !host || !user) {
      throw new McpError(ErrorCode.InvalidParams,
        'name, host, user are required');
    }
    const config = loadConfig();
    const existing = config.connections.findIndex(c => c.name === name);
    const newConn: DbConnection = {
      name,
      host,
      port: port || 3306,
      user,
      password: password || '',
      database: database || '',
    };
    if (existing >= 0) {
      config.connections[existing] = newConn;
    } else {
      config.connections.push(newConn);
    }
    saveConfig(config);
    return this.successResponse({
      success: true,
      message: `Connection '${name}' saved`,
    });
  }

  private async handleUseConnection(args: unknown) {
    const { name } = args as { name: string };
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Connection name required');
    }
    const config = loadConfig();
    const conn = config.connections.find(c => c.name === name);
    if (!conn) {
      throw new McpError(ErrorCode.InvalidParams,
        `Connection '${name}' not found`);
    }
    config.activeConnection = name;
    saveConfig(config);
    await this.recreatePool(conn);
    return this.successResponse({
      success: true,
      message: `Now using connection '${name}'`,
      connection: { name, host: conn.host, database: conn.database },
    });
  }

  private handleDeleteConnection(args: unknown) {
    const { name } = args as { name: string };
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Connection name required');
    }
    const config = loadConfig();
    const index = config.connections.findIndex(c => c.name === name);
    if (index < 0) {
      throw new McpError(ErrorCode.InvalidParams,
        `Connection '${name}' not found`);
    }
    config.connections.splice(index, 1);
    if (config.activeConnection === name) {
      config.activeConnection = null;
    }
    saveConfig(config);
    return this.successResponse({
      success: true,
      message: `Connection '${name}' deleted`,
    });
  }

  private async handleCreateTable(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    if (!isCreateTableQuery(query)) {
      throw new McpError(ErrorCode.InvalidParams,
        'Only CREATE TABLE queries allowed');
    }
    console.error(`[${transactionId}] Creating table`);
    const [result] = await this.pool!.query(query);
    return this.successResponse({ success: true, result });
  }

  private async handleInsertData(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    if (!isInsertQuery(query)) {
      throw new McpError(ErrorCode.InvalidParams, 'Only INSERT queries allowed');
    }
    console.error(`[${transactionId}] Inserting data`);
    const [result] = await this.pool!.query(query);
    return this.successResponse({ success: true, result });
  }

  private async handleUpdateData(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    if (!isUpdateQuery(query)) {
      throw new McpError(ErrorCode.InvalidParams, 'Only UPDATE queries allowed');
    }
    // Check blacklist
    const blacklistCheck = checkSqlBlacklist(query);
    if (blacklistCheck.blocked) {
      throw new McpError(ErrorCode.InvalidParams, `SQL blocked: ${blacklistCheck.reason}`);
    }
    console.error(`[${transactionId}] Updating data`);
    const [result] = await this.pool!.query(query);
    return this.successResponse({ success: true, result });
  }

  private async handleDeleteData(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    if (!isDeleteQuery(query)) {
      throw new McpError(ErrorCode.InvalidParams, 'Only DELETE queries allowed');
    }
    // Check blacklist
    const blacklistCheck = checkSqlBlacklist(query);
    if (blacklistCheck.blocked) {
      throw new McpError(ErrorCode.InvalidParams, `SQL blocked: ${blacklistCheck.reason}`);
    }
    console.error(`[${transactionId}] Deleting data`);
    const [result] = await this.pool!.query(query);
    return this.successResponse({ success: true, result });
  }

  private async handleExecuteSql(args: unknown, transactionId: string) {
    if (!isValidSqlQueryArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query arguments');
    }
    const { query } = args;
    // Check blacklist
    const blacklistCheck = checkSqlBlacklist(query);
    if (blacklistCheck.blocked) {
      throw new McpError(ErrorCode.InvalidParams, `SQL blocked: ${blacklistCheck.reason}`);
    }
    console.error(`[${transactionId}] Executing SQL`);
    const [result] = await this.pool!.query(query);
    return this.successResponse({ success: true, result });
  }

  async run() {
    // Start web server with reference to this instance
    startWebServer(this);

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
      name: c.name, host: c.host, port: c.port, user: c.user,
      database: c.database, active: c.name === config.activeConnection,
    }));
    res.json({ connections, activeConnection: config.activeConnection });
  });

  app.post('/api/connections', (req, res) => {
    const { name, host, port, user, password, database } = req.body;
    if (!name || !host || !user) {
      return res.status(400).json({ error: 'name, host, user required' });
    }
    const config = loadConfig();
    const idx = config.connections.findIndex(c => c.name === name);
    const conn: DbConnection = {
      name, host, port: port || 3306, user,
      password: password || '', database: database || ''
    };
    if (idx >= 0) config.connections[idx] = conn;
    else config.connections.push(conn);
    saveConfig(config);
    res.json({ success: true });
  });

  app.delete('/api/connections/:name', (req, res) => {
    const { name } = req.params;
    const config = loadConfig();
    const idx = config.connections.findIndex(c => c.name === name);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    config.connections.splice(idx, 1);
    if (config.activeConnection === name) config.activeConnection = null;
    saveConfig(config);
    res.json({ success: true });
  });

  // SQL Blacklist API
  app.get('/api/blacklist', (_req, res) => {
    const blacklist = loadBlacklist();
    res.json(blacklist);
  });

  app.put('/api/blacklist', (req, res) => {
    const { enabled, patterns } = req.body;
    const blacklist: SqlBlacklistConfig = { enabled, patterns };
    saveBlacklist(blacklist);
    res.json({ success: true });
  });

  app.post('/api/blacklist/patterns', (req, res) => {
    const { pattern, description, enabled } = req.body;
    if (!pattern) {
      return res.status(400).json({ error: 'pattern required' });
    }
    const blacklist = loadBlacklist();
    const newPattern: SqlBlacklistPattern = {
      id: randomUUID(),
      pattern,
      description: description || '',
      enabled: enabled !== false
    };
    blacklist.patterns.push(newPattern);
    saveBlacklist(blacklist);
    res.json({ success: true, pattern: newPattern });
  });

  app.put('/api/blacklist/patterns/:id', (req, res) => {
    const { id } = req.params;
    const { pattern, description, enabled } = req.body;
    const blacklist = loadBlacklist();
    const idx = blacklist.patterns.findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    if (pattern !== undefined) blacklist.patterns[idx].pattern = pattern;
    if (description !== undefined) blacklist.patterns[idx].description = description;
    if (enabled !== undefined) blacklist.patterns[idx].enabled = enabled;
    saveBlacklist(blacklist);
    res.json({ success: true });
  });

  app.delete('/api/blacklist/patterns/:id', (req, res) => {
    const { id } = req.params;
    const blacklist = loadBlacklist();
    const idx = blacklist.patterns.findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    blacklist.patterns.splice(idx, 1);
    saveBlacklist(blacklist);
    res.json({ success: true });
  });

  app.post('/api/blacklist/reset', (_req, res) => {
    const blacklist: SqlBlacklistConfig = { enabled: true, patterns: DEFAULT_BLACKLIST_PATTERNS };
    saveBlacklist(blacklist);
    res.json({ success: true });
  });

  app.post('/api/blacklist/test', (req, res) => {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'query required' });
    }
    const result = checkSqlBlacklist(query);
    res.json(result);
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
    res.json({ success: true });
  });

  app.post('/api/connections/test', async (req, res) => {
    const { host, port, user, password, database } = req.body;
    try {
      const conn = await mysql.createConnection({
        host, port: port || 3306, user, password, database
      });
      await conn.query('SELECT 1');
      await conn.end();
      res.json({ success: true, message: '连接成功' });
    } catch (e: any) {
      res.json({ success: false, message: e.message });
    }
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
        console.error(`Port ${WEB_PORT} already in use, Web UI disabled for this instance`);
      } else {
        console.error('Web server error:', err);
      }
    });
}

function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MySQL MCP - 连接管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;min-height:100vh}
.layout{display:flex;height:100vh}
.left-panel{width:420px;background:#fff;border-right:1px solid #e0e0e0;padding:20px;overflow-y:auto}
.right-panel{flex:1;padding:20px;overflow-y:auto}
h1{color:#333;margin-bottom:20px;font-size:20px}
h2{color:#555;margin-bottom:15px;font-size:16px;border-bottom:1px solid #eee;padding-bottom:10px}
.form-group{margin-bottom:12px}
.form-group label{display:block;margin-bottom:4px;color:#666;font-size:13px}
.form-group input,.form-group textarea{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px}
.form-group textarea{height:80px;resize:vertical;font-family:monospace}
.form-row{display:flex;gap:10px}
.form-row .form-group{flex:1}
.btn{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:13px}
.btn:hover{opacity:0.85}
.btn-primary{background:#1890ff;color:#fff}
.btn-success{background:#52c41a;color:#fff}
.btn-danger{background:#ff4d4f;color:#fff}
.btn-secondary{background:#d9d9d9;color:#333}
.btn-warning{background:#faad14;color:#fff}
.btn-group{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.parse-box{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:12px;margin-bottom:15px}
.parse-box label{font-weight:500;color:#333}
.parse-hint{font-size:11px;color:#888;margin-top:4px}
.divider{height:1px;background:#eee;margin:15px 0}
.connection-list{list-style:none}
.conn-item{background:#fff;border:1px solid #e8e8e8;border-radius:6px;padding:12px 15px;margin-bottom:10px}
.conn-item:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
.conn-item.active{border-color:#52c41a;background:#f6ffed}
.conn-header{display:flex;justify-content:space-between;align-items:center}
.conn-name{font-size:14px;font-weight:500;color:#333}
.conn-badge{background:#52c41a;color:#fff;padding:2px 8px;border-radius:3px;font-size:11px}
.conn-info{font-size:12px;color:#888;margin-top:6px;font-family:monospace}
.conn-actions{margin-top:10px;display:flex;gap:6px}
.conn-actions .btn{padding:4px 10px;font-size:12px}
.message{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:4px;font-size:14px;z-index:1000}
.message-success{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a}
.message-error{background:#fff2f0;border:1px solid #ffccc7;color:#ff4d4f}
.empty{text-align:center;color:#999;padding:40px 20px}
.lang-switch{position:fixed;top:15px;right:20px;z-index:100;display:flex;align-items:center;gap:8px;background:#fff;padding:6px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.lang-switch select{border:1px solid #ddd;border-radius:4px;padding:4px 8px;font-size:13px;cursor:pointer;background:#fff}
.lang-switch label{font-size:13px;color:#666}
.tabs{display:flex;border-bottom:2px solid #e8e8e8;margin-bottom:15px}
.tab{padding:10px 20px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;color:#666}
.tab:hover{color:#1890ff}
.tab.active{color:#1890ff;border-bottom-color:#1890ff;font-weight:500}
.tab-content{display:none}
.tab-content.active{display:block}
.blacklist-item{background:#fff;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:10px}
.blacklist-item.disabled{opacity:0.6}
.bl-header{display:flex;justify-content:space-between;align-items:center}
.bl-pattern{font-family:monospace;font-size:12px;color:#d63384;background:#f8f9fa;padding:4px 8px;border-radius:3px;word-break:break-all}
.bl-desc{font-size:13px;color:#666;margin-top:6px}
.bl-actions{display:flex;gap:6px;margin-top:8px}
.switch{position:relative;width:40px;height:22px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:22px;transition:.3s}
.slider:before{position:absolute;content:"";height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}
input:checked+.slider{background:#52c41a}
input:checked+.slider:before{transform:translateX(18px)}
.test-box{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:12px;margin-top:15px}
.test-result{margin-top:10px;padding:10px;border-radius:4px;font-size:13px}
.test-result.blocked{background:#fff2f0;border:1px solid #ffccc7;color:#ff4d4f}
.test-result.allowed{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a}
</style>
</head>
<body>
<div class="lang-switch">
<label data-i18n="language">语言</label>
<select id="langSelect" onchange="switchLang(this.value)">
<option value="zh">中文</option>
<option value="en">English</option>
</select>
</div>
<div id="message"></div>
<div class="layout">
<div class="left-panel">
<h1 data-i18n="title">MySQL MCP 连接管理</h1>
<div class="parse-box">
<label data-i18n="smartParse">智能解析配置</label>
<div class="form-group" style="margin-top:8px;margin-bottom:0">
<textarea id="parseInput" data-i18n-placeholder="parsePlaceholder" placeholder="粘贴 Spring Boot 配置、JDBC URL 或其他格式..."></textarea>
</div>
<div class="parse-hint" data-i18n="parseHint">支持: JDBC URL, Spring Boot YAML/Properties, 键值对格式</div>
<button type="button" class="btn btn-warning" style="margin-top:8px" onclick="parseConfig()" data-i18n="parseBtn">解析配置</button>
</div>
<div class="divider"></div>
<h2 data-i18n="connConfig">连接配置</h2>
<form id="form">
<div class="form-row">
<div class="form-group"><label data-i18n="connName">连接名称 *</label><input type="text" id="name" required></div>
<div class="form-group"><label data-i18n="host">主机地址 *</label><input type="text" id="host" required value="localhost"></div>
</div>
<div class="form-row">
<div class="form-group"><label data-i18n="port">端口</label><input type="number" id="port" value="3306"></div>
<div class="form-group"><label data-i18n="username">用户名 *</label><input type="text" id="user" required></div>
</div>
<div class="form-row">
<div class="form-group"><label data-i18n="password">密码</label><input type="password" id="password"></div>
<div class="form-group"><label data-i18n="database">默认数据库</label><input type="text" id="database"></div>
</div>
<div class="btn-group">
<button type="submit" class="btn btn-primary" data-i18n="saveConn">保存连接</button>
<button type="button" class="btn btn-success" onclick="testConn()" data-i18n="testConn">测试连接</button>
<button type="button" class="btn btn-secondary" onclick="clearForm()" data-i18n="clear">清空</button>
</div>
</form>
</div>
<div class="right-panel">
<div class="tabs">
<div class="tab active" onclick="switchTab('connections')" data-i18n="tabConns">连接管理</div>
<div class="tab" onclick="switchTab('blacklist')" data-i18n="tabBlacklist">SQL 黑名单</div>
</div>
<div id="tab-connections" class="tab-content active">
<h2 data-i18n="savedConns">已保存的连接</h2>
<ul id="list" class="connection-list"></ul>
</div>
<div id="tab-blacklist" class="tab-content">
<div id="blacklist-content"></div>
</div>
</div>
</div>
<script>
const $=id=>document.getElementById(id);
const i18n={
zh:{language:'语言',title:'MySQL MCP 连接管理',smartParse:'智能解析配置',parsePlaceholder:'粘贴 Spring Boot 配置、JDBC URL 或其他格式...',parseHint:'支持: JDBC URL, Spring Boot YAML/Properties, 键值对格式',parseBtn:'解析配置',connConfig:'连接配置',connName:'连接名称 *',host:'主机地址 *',port:'端口',username:'用户名 *',password:'密码',database:'默认数据库',saveConn:'保存连接',testConn:'测试连接',clear:'清空',savedConns:'已保存的连接',noConns:'暂无保存的连接',addHint:'在左侧添加新连接',currentUse:'当前使用',use:'使用',edit:'编辑',delete:'删除',saved:'已保存',saveFailed:'保存失败',switched:'已切换',deleted:'已删除',confirmDel:'确定删除?',enterConfig:'请输入配置内容',parsed:'已解析配置',tabConns:'连接管理',tabBlacklist:'SQL 黑名单',blTitle:'SQL 黑名单规则',blEnabled:'启用黑名单过滤',blAdd:'添加规则',blReset:'恢复默认',blPattern:'正则表达式',blDesc:'描述',blTest:'测试 SQL',blTestBtn:'测试',blTestPlaceholder:'输入 SQL 语句测试是否会被拦截...',blBlocked:'已拦截',blAllowed:'允许执行',blNoRules:'暂无规则',blConfirmReset:'确定恢复默认规则？当前规则将被覆盖'},
en:{language:'Language',title:'MySQL MCP Connection Manager',smartParse:'Smart Parse Config',parsePlaceholder:'Paste Spring Boot config, JDBC URL or other formats...',parseHint:'Supports: JDBC URL, Spring Boot YAML/Properties, Key-Value pairs',parseBtn:'Parse Config',connConfig:'Connection Config',connName:'Connection Name *',host:'Host *',port:'Port',username:'Username *',password:'Password',database:'Default Database',saveConn:'Save Connection',testConn:'Test Connection',clear:'Clear',savedConns:'Saved Connections',noConns:'No saved connections',addHint:'Add a new connection on the left',currentUse:'Active',use:'Use',edit:'Edit',delete:'Delete',saved:'Saved',saveFailed:'Save failed',switched:'Switched',deleted:'Deleted',confirmDel:'Confirm delete?',enterConfig:'Please enter config content',parsed:'Config parsed',tabConns:'Connections',tabBlacklist:'SQL Blacklist',blTitle:'SQL Blacklist Rules',blEnabled:'Enable Blacklist',blAdd:'Add Rule',blReset:'Reset Default',blPattern:'Regex Pattern',blDesc:'Description',blTest:'Test SQL',blTestBtn:'Test',blTestPlaceholder:'Enter SQL to test if it will be blocked...',blBlocked:'Blocked',blAllowed:'Allowed',blNoRules:'No rules',blConfirmReset:'Reset to default rules? Current rules will be overwritten'}
};
let lang=localStorage.getItem('mcp-lang')||'zh';
function t(key){return i18n[lang][key]||key}
function switchLang(l){lang=l;localStorage.setItem('mcp-lang',l);document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>el.placeholder=t(el.dataset.i18nPlaceholder));load();if($('tab-blacklist').classList.contains('active'))loadBlacklist()}
function initLang(){$('langSelect').value=lang;switchLang(lang)}
function msg(t,ok){$('message').innerHTML='<div class="message message-'+(ok?'success':'error')+'">'+t+'</div>';setTimeout(()=>$('message').innerHTML='',3000)}
async function load(){
const r=await fetch('/api/connections');
const d=await r.json();
if(!d.connections.length){$('list').innerHTML='<li class="empty">'+t('noConns')+'<br><small>'+t('addHint')+'</small></li>';return}
$('list').innerHTML=d.connections.map(c=>'<li class="conn-item'+(c.active?' active':'')+'"><div class="conn-header"><span class="conn-name">'+c.name+'</span>'+(c.active?'<span class="conn-badge">'+t('currentUse')+'</span>':'')+'</div><div class="conn-info">'+c.user+'@'+c.host+':'+c.port+(c.database?'/'+c.database:'')+'</div><div class="conn-actions">'+(c.active?'':'<button class="btn btn-success" onclick="activate(\\''+c.name+'\\')">'+t('use')+'</button>')+'<button class="btn btn-secondary" onclick="edit(\\''+c.name+'\\')">'+t('edit')+'</button><button class="btn btn-danger" onclick="del(\\''+c.name+'\\')">'+t('delete')+'</button></div></li>').join('')}
$('form').onsubmit=async e=>{e.preventDefault();
const data={name:$('name').value,host:$('host').value,port:+$('port').value||3306,user:$('user').value,password:$('password').value,database:$('database').value};
const r=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
if((await r.json()).success){msg(t('saved'),1);clearForm();load()}else msg(t('saveFailed'),0)}
async function testConn(){
const data={host:$('host').value,port:+$('port').value||3306,user:$('user').value,password:$('password').value,database:$('database').value};
const r=await fetch('/api/connections/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const d=await r.json();msg(d.message,d.success)}
async function activate(n){await fetch('/api/connections/'+n+'/activate',{method:'POST'});msg(t('switched'),1);load()}
async function del(n){if(!confirm(t('confirmDel')))return;await fetch('/api/connections/'+n,{method:'DELETE'});msg(t('deleted'),1);load()}
function clearForm(){$('form').reset();$('host').value='localhost';$('port').value='3306'}
async function edit(n){const r=await fetch('/api/connections');const d=await r.json();const c=d.connections.find(x=>x.name===n);if(c){$('name').value=c.name;$('host').value=c.host;$('port').value=c.port;$('user').value=c.user;$('database').value=c.database||'';$('password').value='';window.scrollTo(0,0)}}
load();
initLang();
// 智能解析配置
function parseConfig(){
const txt=$('parseInput').value.trim();
if(!txt){msg(t('enterConfig'),0);return}
let host='localhost',port=3306,user='',pass='',db='',name='';
// JDBC URL: jdbc:mysql://host:port/database?params
const jdbcMatch=txt.match(/jdbc:mysql:\\/\\/([^:\\/]+)(?::(\\d+))?\\/([^?\\s]+)/i);
if(jdbcMatch){host=jdbcMatch[1];port=jdbcMatch[2]?+jdbcMatch[2]:3306;db=jdbcMatch[3]}
// username/user
const userMatch=txt.match(/(?:username|user)\\s*[:=]\\s*([^\\s\\n]+)/i);
if(userMatch)user=userMatch[1];
// password
const passMatch=txt.match(/password\\s*[:=]\\s*([^\\s\\n]+)/i);
if(passMatch)pass=passMatch[1];
// host (if not from JDBC)
if(!jdbcMatch){const hm=txt.match(/host\\s*[:=]\\s*([^\\s\\n]+)/i);if(hm)host=hm[1]}
// port (if not from JDBC)
if(!jdbcMatch){const pm=txt.match(/port\\s*[:=]\\s*(\\d+)/i);if(pm)port=+pm[1]}
// database (if not from JDBC)
if(!db){const dm=txt.match(/(?:database|db)\\s*[:=]\\s*([^\\s\\n]+)/i);if(dm)db=dm[1]}
// auto name
name=db||host;
$('name').value=name;$('host').value=host;$('port').value=port;
$('user').value=user;$('password').value=pass;$('database').value=db;
msg(t('parsed'),1);$('parseInput').value=''}
// Tab switching
function switchTab(tab){
document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
document.querySelector('.tab[onclick*="'+tab+'"]').classList.add('active');
$('tab-'+tab).classList.add('active');
if(tab==='blacklist')loadBlacklist();
}
// Blacklist functions
async function loadBlacklist(){
const r=await fetch('/api/blacklist');
const d=await r.json();
renderBlacklist(d);
}
function renderBlacklist(data){
const html=\`<h2>\${t('blTitle')}</h2>
<div style="display:flex;align-items:center;gap:15px;margin-bottom:15px">
<label class="switch"><input type="checkbox" \${data.enabled?'checked':''} onchange="toggleBlacklist(this.checked)"><span class="slider"></span></label>
<span>\${t('blEnabled')}</span>
<div style="margin-left:auto;display:flex;gap:8px">
<button class="btn btn-primary" onclick="showAddRule()">\${t('blAdd')}</button>
<button class="btn btn-secondary" onclick="resetBlacklist()">\${t('blReset')}</button>
</div>
</div>
<div id="bl-list">\${data.patterns.length?data.patterns.map(p=>renderRule(p)).join(''):'<div class="empty">'+t('blNoRules')+'</div>'}</div>
<div class="test-box">
<label>\${t('blTest')}</label>
<div style="display:flex;gap:8px;margin-top:8px">
<input type="text" id="testSql" style="flex:1" placeholder="\${t('blTestPlaceholder')}">
<button class="btn btn-warning" onclick="testSql()">\${t('blTestBtn')}</button>
</div>
<div id="testResult"></div>
</div>\`;
$('blacklist-content').innerHTML=html;
}
function renderRule(p){
return \`<div class="blacklist-item \${p.enabled?'':'disabled'}">
<div class="bl-header">
<span class="bl-pattern">\${escHtml(p.pattern)}</span>
<label class="switch"><input type="checkbox" \${p.enabled?'checked':''} onchange="toggleRule('\${p.id}',this.checked)"><span class="slider"></span></label>
</div>
<div class="bl-desc">\${escHtml(p.description)}</div>
<div class="bl-actions">
<button class="btn btn-secondary" onclick="editRule('\${p.id}')">\${t('edit')}</button>
<button class="btn btn-danger" onclick="deleteRule('\${p.id}')">\${t('delete')}</button>
</div>
</div>\`;
}
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
async function toggleBlacklist(enabled){
const r=await fetch('/api/blacklist');
const d=await r.json();
d.enabled=enabled;
await fetch('/api/blacklist',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
msg(t('saved'),1);
}
async function toggleRule(id,enabled){
await fetch('/api/blacklist/patterns/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
loadBlacklist();
}
async function deleteRule(id){
if(!confirm(t('confirmDel')))return;
await fetch('/api/blacklist/patterns/'+id,{method:'DELETE'});
msg(t('deleted'),1);loadBlacklist();
}
async function resetBlacklist(){
if(!confirm(t('blConfirmReset')))return;
await fetch('/api/blacklist/reset',{method:'POST'});
msg(t('saved'),1);loadBlacklist();
}
function showAddRule(){
const pattern=prompt(t('blPattern'),'');
if(!pattern)return;
const desc=prompt(t('blDesc'),'');
addRule(pattern,desc);
}
async function addRule(pattern,desc){
await fetch('/api/blacklist/patterns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pattern,description:desc||''})});
msg(t('saved'),1);loadBlacklist();
}
async function editRule(id){
const r=await fetch('/api/blacklist');
const d=await r.json();
const p=d.patterns.find(x=>x.id===id);
if(!p)return;
const pattern=prompt(t('blPattern'),p.pattern);
if(!pattern)return;
const desc=prompt(t('blDesc'),p.description);
await fetch('/api/blacklist/patterns/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pattern,description:desc||''})});
msg(t('saved'),1);loadBlacklist();
}
async function testSql(){
const sqlInput=document.getElementById('testSql');
if(!sqlInput)return;
const sql=sqlInput.value.trim();
if(!sql)return;
const r=await fetch('/api/blacklist/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:sql})});
const d=await r.json();
const resultEl=document.getElementById('testResult');
if(resultEl)resultEl.innerHTML=d.blocked?
'<div class="test-result blocked">'+t('blBlocked')+': '+escHtml(d.reason||'')+'</div>':
'<div class="test-result allowed">'+t('blAllowed')+'</div>';
}
</script>
</body>
</html>`;
}

const server = new MySqlServer();
server.run().catch(console.error);
