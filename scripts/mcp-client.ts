/**
 * Airtable MCP Client
 *
 * Wrapper client for Airtable REST API via MCP server.
 * Handles bases, tables, and records with automatic table ID resolution.
 * Configuration from config.json with default base ID and API key from environment.
 *
 * Key features:
 * - Automatic table name → table ID resolution
 * - In-memory caching of table mappings
 * - Filter formula support for complex queries
 * - Batch record operations (update, delete)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  defaultBase: string;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "airtable-manager",
  defaultTTL: TTL.FIFTEEN_MINUTES,
});

export class AirtableMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private tableIdCache: Map<string, Map<string, string>> = new Map(); // baseId -> (tableName -> tableId)
  private cacheDisabled: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   * Useful for debugging or when fresh data is required.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   * @returns Cache stats object with hits, misses, and entry count
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   * @param key - The cache key to invalidate
   * @returns true if entry was found and removed, false otherwise
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /**
   * Establishes connection to the MCP server.
   * Called automatically by other methods when needed.
   *
   * @throws {Error} If AIRTABLE_API_KEY environment variable is not set
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    // Ensure AIRTABLE_API_KEY is set
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

  /**
   * Disconnects from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ============================================
  // MCP TOOLS
  // ============================================

  /**
   * Lists available MCP tools from the Airtable server.
   * @returns Array of tool definitions with name and description
   */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Calls an MCP tool with arguments.
   *
   * @param name - Tool name (e.g., "list_bases", "list_records")
   * @param args - Tool arguments
   * @returns Parsed tool response (JSON parsed if possible)
   * @throws {Error} If tool call fails
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({ name, arguments: args });
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

  // ============================================
  // TABLE ID RESOLUTION
  // ============================================

  /**
   * Resolves a table name to its Airtable table ID.
   *
   * Some Airtable MCP tools (describe_table, search_records) only work with
   * table IDs (e.g., "tblXXXXXXX"), not table names. This method handles the
   * automatic resolution.
   *
   * Results are cached in memory per base to avoid repeated API calls.
   *
   * @param tableName - Table name or table ID (IDs starting with "tbl" pass through)
   * @param baseId - Airtable base ID
   * @returns The table ID
   * @throws {Error} If table is not found in the base
   *
   * @example
   * const tableId = await client.resolveTableId("Products", "appXXXXXX");
   * // Returns: "tblYYYYYY"
   */
  private async resolveTableId(tableName: string, baseId: string): Promise<string> {
    // If it looks like a table ID already (starts with "tbl"), return as-is
    if (tableName.startsWith("tbl")) {
      return tableName;
    }

    // Check in-memory cache first
    if (this.tableIdCache.has(baseId)) {
      const baseCache = this.tableIdCache.get(baseId)!;
      if (baseCache.has(tableName)) {
        return baseCache.get(tableName)!;
      }
    }

    // Fetch tables and cache them
    const tablesResult = await this.callTool("list_tables", { baseId });
    const tables = tablesResult.tables || [];

    // Build cache for this base
    const baseCache = new Map<string, string>();
    for (const table of tables) {
      baseCache.set(table.name, table.id);
    }
    this.tableIdCache.set(baseId, baseCache);

    // Look up the requested table
    const tableId = baseCache.get(tableName);
    if (!tableId) {
      throw new Error(`Table "${tableName}" not found in base ${baseId}. Available tables: ${tables.map((t: any) => t.name).join(", ")}`);
    }

    return tableId;
  }

  // ============================================
  // READ OPERATIONS
  // ============================================

  /**
   * Lists all accessible Airtable bases.
   *
   * @returns Object with bases array containing id, name, and permissionLevel
   *
   * @cached TTL: 1 hour
   *
   * @example
   * const { bases } = await client.listBases();
   * for (const base of bases) {
   *   console.log(base.id, base.name);
   * }
   */
  async listBases(): Promise<any> {
    return cache.getOrFetch(
      "bases",
      () => this.callTool("list_bases", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists all tables in a base.
   *
   * @param baseId - Airtable base ID (defaults to configured default base)
   * @returns Object with tables array containing id, name, and field definitions
   *
   * @cached TTL: 1 hour
   *
   * @example
   * const { tables } = await client.listTables();
   * console.log(tables.map(t => t.name)); // ["Products", "Orders", ...]
   */
  async listTables(baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("tables", { baseId: resolvedBaseId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_tables", { baseId: resolvedBaseId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets the schema/field definitions for a table.
   *
   * Automatically resolves table names to IDs.
   *
   * @param tableName - Table name or table ID
   * @param baseId - Airtable base ID (defaults to configured default base)
   * @returns Table schema with field definitions, types, and options
   *
   * @cached TTL: 1 hour
   *
   * @example
   * const schema = await client.describeTable("Products");
   * for (const field of schema.fields) {
   *   console.log(field.name, field.type);
   * }
   */
  async describeTable(tableName: string, baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const tableId = await this.resolveTableId(tableName, resolvedBaseId);
    const cacheKey = createCacheKey("table_schema", { baseId: resolvedBaseId, tableId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("describe_table", {
        baseId: resolvedBaseId,
        tableId: tableId,
      }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists records from a table with optional filtering.
   *
   * Supports Airtable formula filtering for complex queries.
   *
   * @param tableName - Table name or table ID
   * @param options - Query options
   * @param options.baseId - Override default base ID
   * @param options.maxRecords - Maximum records to return
   * @param options.filterFormula - Airtable formula to filter records
   * @param options.view - View name to use (applies view's filters/sorts)
   * @returns Object with records array containing id and fields
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * // Get all products in stock
   * const { records } = await client.listRecords("Products", {
   *   filterFormula: "{In Stock} = TRUE()",
   *   maxRecords: 100
   * });
   *
   * @example
   * // Use a specific view
   * const { records } = await client.listRecords("Orders", {
   *   view: "Pending Orders"
   * });
   */
  async listRecords(
    tableName: string,
    options?: {
      baseId?: string;
      maxRecords?: number;
      filterFormula?: string;
      view?: string;
    }
  ): Promise<any> {
    const resolvedBaseId = options?.baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("records", {
      baseId: resolvedBaseId,
      table: tableName,
      maxRecords: options?.maxRecords,
      filter: options?.filterFormula,
      view: options?.view,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {
          baseId: resolvedBaseId,
          tableId: tableName,
        };

        if (options?.maxRecords) args.maxRecords = options.maxRecords;
        if (options?.filterFormula) args.filterByFormula = options.filterFormula;
        if (options?.view) args.view = options.view;

        return this.callTool("list_records", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets a single record by ID.
   *
   * @param tableName - Table name or table ID
   * @param recordId - Airtable record ID (e.g., "recXXXXXX")
   * @param baseId - Override default base ID
   * @returns Record object with id and fields
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const record = await client.getRecord("Products", "recABC123");
   * console.log(record.fields["SerialNumber"]);
   */
  async getRecord(tableName: string, recordId: string, baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const cacheKey = createCacheKey("record", {
      baseId: resolvedBaseId,
      table: tableName,
      id: recordId,
    });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_record", {
        baseId: resolvedBaseId,
        tableId: tableName,
        recordId: recordId,
      }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Searches records in a table by text.
   *
   * Performs a full-text search across all fields.
   * Automatically resolves table names to IDs.
   *
   * @param tableName - Table name or table ID
   * @param searchTerm - Text to search for
   * @param baseId - Override default base ID
   * @returns Object with matching records
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * // Search for a serial number
   * const results = await client.searchRecords("Products", "L9EXXX12345");
   */
  async searchRecords(tableName: string, searchTerm: string, baseId?: string): Promise<any> {
    const resolvedBaseId = baseId || this.config.defaultBase;
    const tableId = await this.resolveTableId(tableName, resolvedBaseId);
    const cacheKey = createCacheKey("search", {
      baseId: resolvedBaseId,
      tableId,
      term: searchTerm,
    });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("search_records", {
        baseId: resolvedBaseId,
        tableId: tableId,
        searchTerm: searchTerm,
      }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // MUTATION OPERATIONS
  // ============================================

  /**
   * Creates a new record in a table.
   *
   * @param tableName - Table name or table ID
   * @param fields - Field values to set (field name → value)
   * @param baseId - Override default base ID
   * @returns Created record object with id and fields
   *
   * @invalidates records/{tableName}/*
   *
   * @example
   * const record = await client.createRecord("Products", {
   *   "SerialNumber": "L9EXXX12345",
   *   "Model": "Product A",
   *   "In Stock": true
   * });
   * console.log("Created:", record.id);
   */
  async createRecord(tableName: string, fields: Record<string, any>, baseId?: string): Promise<any> {
    const result = await this.callTool("create_record", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      fields: fields,
    });
    // Invalidate records cache for this table
    cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
    return result;
  }

  /**
   * Updates one or more records in a table.
   *
   * Supports batch updates - each record needs an id and fields to update.
   * Only specified fields are updated; other fields remain unchanged.
   *
   * @param tableName - Table name or table ID
   * @param records - Array of records to update, each with id and fields
   * @param baseId - Override default base ID
   * @returns Array of updated record objects
   *
   * @invalidates records/{tableName}/*, record/{recordId}
   *
   * @example
   * // Update single record
   * await client.updateRecords("Products", [
   *   { id: "recABC123", fields: { "In Stock": false } }
   * ]);
   *
   * @example
   * // Batch update multiple records
   * await client.updateRecords("Products", [
   *   { id: "recABC123", fields: { "Status": "Sold" } },
   *   { id: "recDEF456", fields: { "Status": "Sold" } },
   * ]);
   */
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
    // Invalidate records cache for this table
    cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
    // Invalidate individual record caches
    for (const record of records) {
      cache.invalidate(createCacheKey("record", {
        baseId: baseId || this.config.defaultBase,
        table: tableName,
        id: record.id,
      }));
    }
    return result;
  }

  /**
   * Deletes one or more records from a table.
   *
   * @param tableName - Table name or table ID
   * @param recordIds - Array of record IDs to delete
   * @param baseId - Override default base ID
   * @returns Confirmation of deleted records
   *
   * @invalidates records/{tableName}/*
   *
   * @example
   * await client.deleteRecords("Products", ["recABC123", "recDEF456"]);
   */
  async deleteRecords(tableName: string, recordIds: string[], baseId?: string): Promise<any> {
    const result = await this.callTool("delete_records", {
      baseId: baseId || this.config.defaultBase,
      tableId: tableName,
      recordIds: recordIds,
    });
    // Invalidate records cache for this table
    cache.invalidatePattern(new RegExp(`^records.*table=${tableName}`));
    return result;
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Gets the configured default base ID.
   *
   * @returns Airtable base ID from config.json
   */
  getDefaultBase(): string {
    return this.config.defaultBase;
  }
}

export default AirtableMCPClient;
