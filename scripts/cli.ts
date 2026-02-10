#!/usr/bin/env npx tsx
/**
 * Airtable Manager CLI
 *
 * Zod-validated CLI for Airtable database operations via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { AirtableMCPClient } from "./mcp-client.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: AirtableMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools"
  ),

  "list-bases": createCommand(
    z.object({}),
    async (_args, client: AirtableMCPClient) => client.listBases(),
    "List all accessible Airtable bases"
  ),

  "list-tables": createCommand(
    z.object({
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { base } = args as { base?: string };
      return client.listTables(base);
    },
    "List all tables in a base"
  ),

  "describe-table": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, base } = args as { table: string; base?: string };
      return client.describeTable(table, base);
    },
    "Get schema for a table"
  ),

  "list-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
      limit: cliTypes.int(1, 100).optional().describe("Max records to return"),
      filter: z.string().optional().describe("Airtable filter formula"),
      view: z.string().optional().describe("Airtable view name"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, base, limit, filter, view } = args as {
        table: string;
        base?: string;
        limit?: number;
        filter?: string;
        view?: string;
      };
      return client.listRecords(table, {
        baseId: base,
        maxRecords: limit,
        filterFormula: filter,
        view,
      });
    },
    "List records from a table"
  ),

  "get-record": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      id: z.string().min(1).describe("Record ID"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, id, base } = args as { table: string; id: string; base?: string };
      return client.getRecord(table, id, base);
    },
    "Get a single record by ID"
  ),

  "search-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      query: z.string().min(1).describe("Search term"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, query, base } = args as { table: string; query: string; base?: string };
      return client.searchRecords(table, query, base);
    },
    "Search records in a table"
  ),

  "create-record": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      fields: z.string().min(1).describe("JSON object of field values"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, fields, base } = args as { table: string; fields: string; base?: string };
      const parsedFields = JSON.parse(fields);
      return client.createRecord(table, parsedFields, base);
    },
    "Create a new record"
  ),

  "update-record": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      id: z.string().min(1).describe("Record ID"),
      fields: z.string().min(1).describe("JSON object of field values"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, id, fields, base } = args as {
        table: string;
        id: string;
        fields: string;
        base?: string;
      };
      const parsedFields = JSON.parse(fields);
      return client.updateRecords(table, [{ id, fields: parsedFields }], base);
    },
    "Update an existing record"
  ),

  "delete-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      id: z.string().optional().describe("Single record ID"),
      ids: z.string().optional().describe("Comma-separated record IDs"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }).refine(
      (data) => data.id !== undefined || data.ids !== undefined,
      { message: "Either --id or --ids is required" }
    ),
    async (args, client: AirtableMCPClient) => {
      const { table, id, ids, base } = args as {
        table: string;
        id?: string;
        ids?: string;
        base?: string;
      };
      const recordIds = ids
        ? ids.split(",").map((rid) => rid.trim())
        : [id!];
      return client.deleteRecords(table, recordIds, base);
    },
    "Delete records by ID"
  ),

  // Pre-built cache commands
  ...cacheCommands<AirtableMCPClient>(),
};

// Run CLI
runCli(commands, AirtableMCPClient, {
  programName: "airtable-cli",
  description: "Airtable database operations via MCP",
});
