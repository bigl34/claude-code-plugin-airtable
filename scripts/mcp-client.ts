
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { spawn, ChildProcess } from "child_process";
import { loadServiceConfig } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

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

export class AirtableMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private tableIdCache: Map<string, Map<string, string>> = new Map();
  private cacheDisabled: boolean = false;
  private injectedClient: MinimalMcpClient | null;
  private readonly cache: PluginCache;

  constructor(opts?: { client?: MinimalMcpClient; config?: MCPConfig; cacheDir?: string }) {
    this.injectedClient = opts?.client ?? null;
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
    this.cacheDisabled = true;
    this.cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
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


  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.injectedClient) {
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

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "airtable-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
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

    const result = await this.client!.callTool({ name, arguments: args }, undefined, options);
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


  async listBases(): Promise<any> {
    return this.cache.getOrFetch(
      "bases",
      () => this.callTool("list_bases", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async listTables(baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("tables", { baseId: resolvedBaseId });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_tables", { baseId: resolvedBaseId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
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
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async listRecords(
    tableName: string,
    options?: {
      baseId?: string;
      maxRecords?: number;
      filterFormula?: string;
      view?: string;
      offset?: string;
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
      offset: options?.offset,
      fields: options?.fields?.length
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
        if (options?.offset) args.offset = options.offset;
        if (options?.fields?.length) args.fields = options.fields;

        return this.callTool("list_records", args, { timeout: 150_000 });
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
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
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
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
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async createRecord(tableName: string, fields: Record<string, any>, baseId?: string): Promise<any> {
    const result = await this.callTool("create_record", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      fields: fields,
    });
    this.cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
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
    this.cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
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
    this.cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
    return result;
  }


  getDefaultBase(): string {
    return this.config.defaultBase;
  }
}

export default AirtableMCPClient;
