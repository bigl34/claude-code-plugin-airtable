
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { loadServiceConfig } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

export const STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export const SDK_MAX_BUFFER_MIN_VERSION = "1.30.1";

const SDK_PACKAGE_NAME = "@modelcontextprotocol/sdk";

const SDK_STDIO_ENTRY = "@modelcontextprotocol/sdk/client/stdio.js";

const VERSION_CORE_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)/;

const READ_BUFFER_OVERFLOW_PATTERN = /^ReadBuffer exceeded maximum size/;

type BoundedStdioServerParameters = StdioServerParameters & { maxBufferSize: number };

function parseVersionCore(version: string): number[] | null {
  const coreMatch = VERSION_CORE_PATTERN.exec(version);
  if (coreMatch === null) return null;
  const numericParts = coreMatch.slice(1, 4).map(Number);
  return numericParts;
}

export function isVersionOlder(version: string, minimum: string): boolean {
  const versionParts = parseVersionCore(version);
  const minimumParts = parseVersionCore(minimum);
  if (versionParts === null || minimumParts === null) return false;
  for (let index = 0; index < versionParts.length; index += 1) {
    const difference = versionParts[index] - minimumParts[index];
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function resolveSdkStdioEntry(): string {
  const requireFromClient = createRequire(import.meta.url);
  return requireFromClient.resolve(SDK_STDIO_ENTRY);
}

function readPackageManifest(manifestPath: string): { name?: unknown; version?: unknown } | null {
  try {
    const manifestText = readFileSync(manifestPath, "utf8");
    return JSON.parse(manifestText) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}

export function readResolvedSdkVersion(resolveEntry: () => string = resolveSdkStdioEntry): string | null {
  let directory: string;
  try {
    directory = dirname(resolveEntry());
  } catch {
    return null;
  }
  while (true) {
    const manifest = readPackageManifest(join(directory, "package.json")); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const isSdkManifest = manifest?.name === SDK_PACKAGE_NAME;
    if (isSdkManifest) return typeof manifest.version === "string" ? manifest.version : null;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) return null;
    directory = parentDirectory;
  }
}

function staleSdkWarningMessage(version: string): string {
  const bufferMib = STDIO_MAX_BUFFER_BYTES / (1024 * 1024);
  return (
    `[airtable-manager] warning: the resolved ${SDK_PACKAGE_NAME} ${version} is older than ` +
    `${SDK_MAX_BUFFER_MIN_VERSION} and ignores maxBufferSize, so the ${bufferMib} MiB stdio read limit is not ` +
    `applied; run npm ci at the repo root.`
  );
}

export function createStaleSdkWarning(
  readVersion: () => string | null,
  writeWarning: (message: string) => void,
): () => void {
  let checked = false;
  return () => {
    if (checked) return;
    checked = true;
    const version = readVersion();
    if (version === null) return;
    const ignoresMaxBufferSize = isVersionOlder(version, SDK_MAX_BUFFER_MIN_VERSION);
    if (!ignoresMaxBufferSize) return;
    writeWarning(staleSdkWarningMessage(version));
  };
}

const warnIfSdkIgnoresMaxBufferSize = createStaleSdkWarning(
  () => readResolvedSdkVersion(),
  (message) => process.stderr.write(`${message}\n`),
);

interface ListedTool {
  name?: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  defaultBase: string;
}

export interface MinimalMcpClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: RequestOptions,
  ): Promise<{
    content: unknown;
    isError?: boolean;
  }>;
  listTools(): Promise<{ tools: unknown[] }>;
  close(): Promise<void>;
  onerror?: (error: Error) => void;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let productionCache: PluginCache | null = null;

function getProductionCache(): PluginCache {
  productionCache ??= new PluginCache({
    namespace: "airtable-manager",
    defaultTTL: TTL.FIFTEEN_MINUTES,
  });
  return productionCache;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class AirtableMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private tableIdCache: Map<string, Map<string, string>> = new Map();
  private injectedClient: MinimalMcpClient | null;
  private readonly cache: PluginCache;
  private readonly maxBufferSize: number;
  private readonly checkSdkVersion: () => void;
  private bufferOverflowError: Error | null = null;

  constructor(opts?: {
    client?: MinimalMcpClient;
    config?: MCPConfig;
    cacheDir?: string;
    maxBufferSize?: number;
    checkSdkVersion?: () => void;
  }) {
    this.injectedClient = opts?.client ?? null;
    this.maxBufferSize = opts?.maxBufferSize ?? STDIO_MAX_BUFFER_BYTES;
    this.checkSdkVersion = opts?.checkSdkVersion ?? warnIfSdkIgnoresMaxBufferSize;
    this.cache = opts?.cacheDir
      ? new PluginCache({
          namespace: "airtable-manager",
          defaultTTL: TTL.FIFTEEN_MINUTES,
          cacheDir: opts.cacheDir,
        })
      : getProductionCache();

    if (opts?.config) {
      this.config = opts.config;
    } else if (opts?.client) {
      this.config = { mcpServer: { command: "", args: [] }, defaultBase: "" };
    } else {
      this.config = loadServiceConfig<MCPConfig>("airtable-manager", {
        remedy: "Run cred-loader-sync to regenerate credentials.",
      });
    }
  }


  disableCache(): void {
    this.cache.disable();
  }

  enableCache(): void {
    this.cache.enable();
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(): number {
    return this.cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return this.cache.invalidate(key);
  }

  private invalidateRecordLists(tableName: string): void {
    const escapedTableName = escapeRegExp(tableName);
    const recordListKeys = new RegExp(`^records\\?(?:.*&)?table=${escapedTableName}(?:&|$)`, "s"); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    this.cache.invalidatePattern(recordListKeys);
  }


  async connect(): Promise<void> {
    if (this.connected) return;
    this.bufferOverflowError = null;

    if (this.injectedClient) {
      this.injectedClient.onerror = (error) => this.noteTransportError(error);
      this.client = this.injectedClient as unknown as Client;
      this.connected = true;
      return;
    }

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    if (!env.AIRTABLE_API_KEY) {
      throw new Error(
        "AIRTABLE_API_KEY environment variable is not set. " +
        "Please export it in your shell or add it to ~/.bashrc"
      );
    }

    this.checkSdkVersion();
    const transportParams: BoundedStdioServerParameters = {
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
      maxBufferSize: this.maxBufferSize,
    };
    this.transport = new StdioClientTransport(transportParams);

    this.client = new Client(
      { name: "airtable-cli", version: "1.0.0" },
      { capabilities: {} }
    );
    this.client.onerror = (error) => this.noteTransportError(error);

    await this.client.connect(this.transport);
    this.connected = true;
  }

  private noteTransportError(error: Error): void {
    const isBufferOverflow = READ_BUFFER_OVERFLOW_PATTERN.test(error.message);
    if (isBufferOverflow) this.bufferOverflowError ??= error;
  }

  private explainTransportFailure(toolName: string, error: unknown): unknown {
    const overflowError = this.bufferOverflowError;
    const errorCode = (error as { code?: unknown } | null)?.code;
    const isConnectionClosed = errorCode === ErrorCode.ConnectionClosed;
    if (!isConnectionClosed || overflowError === null) return error;
    const explainedMessage =
      `${toolName} failed: the MCP stdio transport closed because one response exceeded its read buffer ` +
      `(${overflowError.message}). Narrow the read with --limit, --filter or --view.`;
    return new Error(explainedMessage, { cause: error });
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }


  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, any>,
    options?: RequestOptions,
  ): Promise<any> {
    await this.connect();

    const result = await this.client!
      .callTool({ name, arguments: args }, undefined, options)
      .catch((error: unknown) => {
        throw this.explainTransportFailure(name, error);
      });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      throw new Error(errorContent?.text || "Tool call failed");
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }


  private async resolveTableId(tableName: string, baseId: string): Promise<string> {
    if (tableName.startsWith("tbl")) {
      return tableName;
    }

    if (this.tableIdCache.has(baseId)) {
      const baseCache = this.tableIdCache.get(baseId)!;
      if (baseCache.has(tableName)) {
        return baseCache.get(tableName)!;
      }
    }

    const tablesResult = await this.callTool("list_tables", { baseId });
    const tables = tablesResult.tables || [];

    const baseCache = new Map<string, string>();
    for (const table of tables) {
      baseCache.set(table.name, table.id);
    }
    this.tableIdCache.set(baseId, baseCache);

    const tableId = baseCache.get(tableName);
    if (!tableId) {
      throw new Error(`Table "${tableName}" not found in base ${baseId}. Available tables: ${tables.map((t: any) => t.name).join(", ")}`);
    }

    return tableId;
  }

  private async assertListRecordsAcceptsFields(): Promise<void> {
    const tools: ListedTool[] = await this.listTools();
    const listRecordsTool = tools.find((tool) => tool.name === "list_records");
    const inputProperties = listRecordsTool?.inputSchema?.properties ?? {};
    const acceptsFields = Object.hasOwn(inputProperties, "fields");
    if (acceptsFields) return;
    throw new Error(
      "list-records --fields cannot be honoured: the launched airtable-mcp-server's list_records tool " +
      "has no \"fields\" input (it was added in 1.14.0), so every field would come back. " +
      "Omit --fields and narrow with --filter, --view or --limit."
    );
  }


  async listBases(): Promise<any> {
    return this.cache.getOrFetch(
      "bases",
      () => this.callTool("list_bases", {}),
      { ttl: TTL.HOUR }
    );
  }

  async listTables(baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("tables", { baseId: resolvedBaseId });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_tables", { baseId: resolvedBaseId }),
      { ttl: TTL.HOUR }
    );
  }

  async describeTable(tableName: string, baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const tableId = await this.resolveTableId(tableName, resolvedBaseId);
    const cacheKey = createCacheKey("table_schema", { baseId: resolvedBaseId, tableId });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("describe_table", {
        baseId: resolvedBaseId,
        tableId: tableId,
      }),
      { ttl: TTL.HOUR }
    );
  }

  async listRecords(
    tableName: string,
    options?: {
      baseId?: string;
      maxRecords?: number;
      filterFormula?: string;
      view?: string;
      fields?: string[];
    }
  ): Promise<any> {
    const resolvedBaseId = options?.baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("records", {
      baseId: resolvedBaseId,
      table: tableName,
      maxRecords: options?.maxRecords,
      filter: options?.filterFormula,
      view: options?.view,
      projectedFields: options?.fields?.length
        ? JSON.stringify([...options.fields].sort())
        : undefined,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {
          baseId: resolvedBaseId,
          tableId: tableName,
        };

        if (options?.maxRecords) args.maxRecords = options.maxRecords;
        if (options?.filterFormula) args.filterByFormula = options.filterFormula;
        if (options?.view) args.view = options.view;
        if (options?.fields?.length) {
          await this.assertListRecordsAcceptsFields();
          args.fields = options.fields;
        }

        return this.callTool("list_records", args, { timeout: 150_000 });
      },
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async getRecord(tableName: string, recordId: string, baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("record", {
      baseId: resolvedBaseId,
      table: tableName,
      id: recordId,
    });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_record", {
        baseId: resolvedBaseId,
        tableId: tableName,
        recordId: recordId,
      }),
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async searchRecords(
    tableName: string,
    searchTerm: string,
    baseId?: string,
    maxRecords?: number,
  ): Promise<unknown> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const tableId = await this.resolveTableId(tableName, resolvedBaseId);
    const cacheKey = createCacheKey("search", {
      baseId: resolvedBaseId,
      tableId,
      term: searchTerm,
      maxRecords,
    });

    return this.cache.getOrFetch(
      cacheKey,
      () => {
        const args: Record<string, unknown> = {
          baseId: resolvedBaseId,
          tableId: tableId,
          searchTerm: searchTerm,
        };
        if (maxRecords !== undefined) args.maxRecords = maxRecords;
        return this.callTool("search_records", args);
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }


  async createRecord(tableName: string, fields: Record<string, any>, baseId?: string): Promise<any> {
    const result = await this.callTool("create_record", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      fields: fields,
    });
    this.invalidateRecordLists(tableName);
    return result;
  }

  async updateRecords(
    tableName: string,
    records: Array<{ id: string; fields: Record<string, any> }>,
    baseId?: string
  ): Promise<any> {
    const result = await this.callTool("update_records", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      records: records,
    });
    this.invalidateRecordLists(tableName);
    for (const record of records) {
      this.cache.invalidate(createCacheKey("record", {
        baseId: baseId || this.config.defaultBase,
        table: tableName,
        id: record.id,
      }));
    }
    return result;
  }

  async deleteRecords(tableName: string, recordIds: string[], baseId?: string): Promise<any> {
    const result = await this.callTool("delete_records", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      recordIds: recordIds,
    });
    this.invalidateRecordLists(tableName);
    return result;
  }


  getDefaultBase(): string {
    return this.config.defaultBase;
  }
}

export default AirtableMCPClient;
