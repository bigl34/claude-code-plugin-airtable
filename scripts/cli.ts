#!/usr/bin/env npx tsx

import {
  z,
  createCommand,
  runCli,
  cacheCommands,
  cliTypes,
  wrapUntrustedField,
  buildSafeOutput,
  TRUNCATION_DEFAULTS,
  type WrappedField,
} from "@local/cli-utils";
import { AirtableMCPClient } from "./mcp-client.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";


const AIRTABLE_ID_RE = /^(rec|usr|att|tbl|app|fld)[A-Za-z0-9]{14,}$/;

const AIRTABLE_RECORD_ID_RE = /^rec[A-Za-z0-9]{14,}$/;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function chooseMaxChars(fieldName: string): number {
  const lower = fieldName.toLowerCase();

  const isBodyField =
    lower.includes("description") ||
    lower.includes("notes") ||
    lower.includes("note") ||
    lower.includes("history") ||
    lower.includes("comment") ||
    lower.includes("body") ||
    lower.includes("message") ||
    lower.includes("details");
  if (isBodyField) return TRUNCATION_DEFAULTS.body;

  const isShortName =
    lower === "name" ||
    lower.endsWith(" name") ||
    (lower.endsWith("name") && lower.length <= 20);
  const isContactLike =
    lower.includes("email") ||
    lower.includes("phone") ||
    lower.includes("contact");
  if (isShortName || isContactLike) return TRUNCATION_DEFAULTS.displayName;

  return TRUNCATION_DEFAULTS.subject;
}

function isTrustedScalar(value: string): boolean {
  if (AIRTABLE_ID_RE.test(value)) return true;
  if (ISO_TIMESTAMP_RE.test(value)) return true;
  return false;
}

function wrapFieldValue(
  fieldPath: string,
  fieldName: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    if (isTrustedScalar(value)) return value;
    return wrapUntrustedField(fieldPath, value, { maxChars: chooseMaxChars(fieldName) });
  }

  if (Array.isArray(value)) {
    const allLookLikeIds =
      value.length > 0 &&
      value.every((v) => typeof v === "string" && AIRTABLE_ID_RE.test(v));
    if (allLookLikeIds) return value;

    return value.map((element, index) => {
      const elementPath = `${fieldPath}[${index}]`;
      if (typeof element === "string") {
        if (isTrustedScalar(element)) return element;
        return wrapUntrustedField(elementPath, element, { maxChars: chooseMaxChars(fieldName) });
      }
      return element;
    });
  }

  return value;
}

function wrapRecordFields(
  record: { id?: string; fields?: Record<string, unknown>; createdTime?: string },
  pathPrefix: string,
): { id?: string; createdTime?: string; fields: Record<string, unknown> } {
  const wrappedFields: Record<string, unknown> = {};
  const sourceFields = record?.fields ?? {};

  for (const [fieldName, value] of Object.entries(sourceFields)) {
    const fieldPath = `${pathPrefix}.${fieldName}`;
    wrappedFields[fieldName] = wrapFieldValue(fieldPath, fieldName, value);
  }

  return {
    id: record?.id,
    createdTime: record?.createdTime,
    fields: wrappedFields,
  };
}

function wrapRecordList(
  raw: unknown,
  pathPrefix: string,
): Array<{ id?: string; createdTime?: string; fields: Record<string, unknown> }> {
  const records = (raw as { records?: unknown[] } | undefined)?.records;
  if (!Array.isArray(records)) return [];
  return records.map((record, index) =>
    wrapRecordFields(
      record as { id?: string; fields?: Record<string, unknown>; createdTime?: string },
      `${pathPrefix}[${index}]`,
    ),
  );
}

export const __wrapInternals = {
  wrapFieldValue,
  wrapRecordFields,
  wrapRecordList,
  chooseMaxChars,
  isTrustedScalar,
};

function normalizeProjectedFields(input?: string): string[] | undefined {
  if (input === undefined) return undefined;

  const fields = input.split(",").map((field) => field.trim());
  if (fields.some((field) => field.length === 0)) {
    throw new Error(
      "--fields must be a comma-separated list of non-blank field names or IDs",
    );
  }

  const duplicate = fields.find(
    (field, index) => fields.indexOf(field) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`Duplicate projected field: ${duplicate}`);
  }

  return fields;
}

function normalizeDeleteRecordIds(input: {
  id?: string;
  ids?: string;
}): string[] {
  const hasId = input.id !== undefined;
  const hasIds = input.ids !== undefined;

  if (hasId === hasIds) {
    throw new Error("Exactly one of --id or --ids is required");
  }

  const rawIds = hasIds ? input.ids!.split(",") : [input.id!];
  const recordIds = rawIds.map((recordId) => recordId.trim());

  if (recordIds.some((recordId) => recordId.length === 0)) {
    throw new Error("Record IDs must not be blank");
  }

  const malformedId = recordIds.find((recordId) => !AIRTABLE_RECORD_ID_RE.test(recordId));
  if (malformedId !== undefined) {
    throw new Error(
      `Invalid Airtable record ID: ${malformedId}. Expected rec followed by at least 14 alphanumeric characters`,
    );
  }

  const duplicateId = recordIds.find(
    (recordId, index) => recordIds.indexOf(recordId) !== index,
  );
  if (duplicateId !== undefined) {
    throw new Error(`Duplicate Airtable record ID: ${duplicateId}`);
  }

  return recordIds;
}

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
    "List all available MCP tools",
    { sideEffect: "read" }
  ),

  "list-bases": createCommand(
    z.object({}),
    async (_args, client: AirtableMCPClient) => {
      const raw = await client.listBases();
      const bases = (raw?.bases ?? []) as Array<{
        id?: string;
        name?: string;
        permissionLevel?: string;
      }>;
      const wrappedBases = bases.map((base, index) => ({
        id: base.id,
        permissionLevel: base.permissionLevel,
        name:
          typeof base.name === "string"
            ? wrapUntrustedField(`bases[${index}].name`, base.name, {
                maxChars: TRUNCATION_DEFAULTS.displayName,
              })
            : base.name,
      }));
      return buildSafeOutput(
        { command: "list-bases", count: wrappedBases.length },
        { bases: wrappedBases },
      );
    },
    "List all accessible Airtable bases",
    { sideEffect: "read" }
  ),

  "list-tables": createCommand(
    z.object({
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { base } = args as { base?: string };
      const raw = await client.listTables(base);
      const tables = (raw?.tables ?? []) as Array<{
        id?: string;
        name?: string;
        primaryFieldId?: string;
        fields?: unknown[];
        views?: unknown[];
      }>;
      const wrappedTables = tables.map((table, index) => ({
        id: table.id,
        primaryFieldId: table.primaryFieldId,
        name:
          typeof table.name === "string"
            ? wrapUntrustedField(`tables[${index}].name`, table.name, {
                maxChars: TRUNCATION_DEFAULTS.displayName,
              })
            : table.name,
      }));
      return buildSafeOutput(
        {
          command: "list-tables",
          base_id: base ?? client.getDefaultBase(),
          count: wrappedTables.length,
        },
        { tables: wrappedTables },
      );
    },
    "List all tables in a base",
    { sideEffect: "read" }
  ),

  "describe-table": createCommand(
    z.object({
      table: z.string().min(1).optional().describe("Table name or ID"),
      tableId: z.string().min(1).optional().describe("Table ID"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
      baseId: z.string().optional().describe("Base ID (uses default if omitted)"),
    }).refine((value) => Boolean(value.table ?? value.tableId), {
      message: "Either --table or --table-id is required",
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, tableId, base, baseId } = args as { table?: string; tableId?: string; base?: string; baseId?: string };
      const resolvedTable = table ?? tableId;
      const resolvedBase = base ?? baseId;
      if (!resolvedTable) {
        throw new Error("Either --table or --table-id is required");
      }
      const schema = await client.describeTable(resolvedTable, resolvedBase);
      const name = (schema as { name?: string } | undefined)?.name;
      const resolvedTableId = (schema as { id?: string } | undefined)?.id;
      const primaryFieldId = (schema as { primaryFieldId?: string } | undefined)?.primaryFieldId;
      const fields = (schema as { fields?: unknown[] } | undefined)?.fields ?? [];
      const views = (schema as { views?: unknown[] } | undefined)?.views ?? [];
      return buildSafeOutput(
        {
          command: "describe-table",
          base_id: resolvedBase ?? client.getDefaultBase(),
          table_id: resolvedTableId,
          primary_field_id: primaryFieldId,
          field_count: Array.isArray(fields) ? fields.length : 0,
          view_count: Array.isArray(views) ? views.length : 0,
        },
        {
          name:
            typeof name === "string"
              ? wrapUntrustedField("name", name, {
                  maxChars: TRUNCATION_DEFAULTS.displayName,
                })
              : name,
          schema: { fields, views },
        },
      );
    },
    "Get schema for a table",
    { sideEffect: "read" }
  ),

  "list-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
      limit: cliTypes.int(1, 100).optional().describe("Max records to return (per page)"),
      filter: z.string().optional().describe("Airtable filter formula"),
      view: z.string().optional().describe("Airtable view name"),
      fields: z.string().superRefine((value, context) => {
        try {
          normalizeProjectedFields(value);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }).optional().describe("Comma-separated exact field names or IDs to return"),
      offset: z.string().optional().describe("Pagination cursor — pass metadata.offset from previous response"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, base, limit, filter, view, fields, offset } = args as {
        table: string;
        base?: string;
        limit?: number;
        filter?: string;
        view?: string;
        fields?: string;
        offset?: string;
      };
      const projectedFields = normalizeProjectedFields(fields);
      const raw = await client.listRecords(table, {
        baseId: base,
        maxRecords: limit,
        filterFormula: filter,
        view,
        fields: projectedFields,
        offset,
      });
      const wrappedRecords = wrapRecordList(raw, "records");
      const nextOffset = (raw as { offset?: string } | undefined)?.offset;
      return buildSafeOutput(
        {
          command: "list-records",
          base_id: base ?? client.getDefaultBase(),
          table,
          count: wrappedRecords.length,
          fields: projectedFields,
          offset: nextOffset,
          has_more: nextOffset !== undefined,
        },
        { records: wrappedRecords },
      );
    },
    "List records from a table",
    { sideEffect: "read" }
  ),

  "get-record": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      id: z.string().min(1).describe("Record ID"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, id, base } = args as { table: string; id: string; base?: string };
      const raw = await client.getRecord(table, id, base);
      const record = raw as { id?: string; fields?: Record<string, unknown>; createdTime?: string };
      const wrapped = wrapRecordFields(record, "record");
      return buildSafeOutput(
        {
          command: "get-record",
          base_id: base ?? client.getDefaultBase(),
          table,
          record_id: wrapped.id ?? id,
          created_time: wrapped.createdTime,
        },
        { fields: wrapped.fields },
      );
    },
    "Get a single record by ID",
    { sideEffect: "read" }
  ),

  "search-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      query: z.string().min(1).describe("Search term"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
      limit: cliTypes.int(1, 100).optional().describe("Max matching records to return"),
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, query, base, limit } = args as {
        table: string;
        query: string;
        base?: string;
        limit?: number;
      };
      const raw = await client.searchRecords(table, query, base, limit);
      const wrappedRecords = wrapRecordList(raw, "records");
      return buildSafeOutput(
        {
          command: "search-records",
          base_id: base ?? client.getDefaultBase(),
          table,
          query,
          limit,
          count: wrappedRecords.length,
        },
        { records: wrappedRecords },
      );
    },
    "Search records in a table",
    { sideEffect: "read" }
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
      const raw = await client.createRecord(table, parsedFields, base);
      const record = raw as { id?: string; fields?: Record<string, unknown>; createdTime?: string };
      const wrapped = wrapRecordFields(record, "record");
      return buildSafeOutput(
        {
          command: "create-record",
          base_id: base ?? client.getDefaultBase(),
          table,
          record_id: wrapped.id,
          created_time: wrapped.createdTime,
        },
        { fields: wrapped.fields },
      );
    },
    "Create a new record",
    { sideEffect: "write" }
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
      const raw = await client.updateRecords(table, [{ id, fields: parsedFields }], base);
      const records: unknown[] = Array.isArray(raw)
        ? raw
        : ((raw as { records?: unknown[] } | undefined)?.records ?? []);
      const wrappedRecords = records.map((rec, index) =>
        wrapRecordFields(
          rec as { id?: string; fields?: Record<string, unknown>; createdTime?: string },
          `records[${index}]`,
        ),
      );
      return buildSafeOutput(
        {
          command: "update-record",
          base_id: base ?? client.getDefaultBase(),
          table,
          record_id: id,
          count: wrappedRecords.length,
        },
        { records: wrappedRecords },
      );
    },
    "Update an existing record",
    { sideEffect: "write" }
  ),

  "delete-records": createCommand(
    z.object({
      table: z.string().min(1).describe("Table name"),
      id: z.string().optional().describe("Single record ID"),
      ids: z.string().optional().describe("Comma-separated record IDs"),
      base: z.string().optional().describe("Base ID (uses default if omitted)"),
    }).superRefine((data, context) => {
      try {
        normalizeDeleteRecordIds(data);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: data.ids !== undefined ? ["ids"] : data.id !== undefined ? ["id"] : [],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
    async (args, client: AirtableMCPClient) => {
      const { table, id, ids, base } = args as {
        table: string;
        id?: string;
        ids?: string;
        base?: string;
      };
      const recordIds = normalizeDeleteRecordIds({ id, ids });
      return client.deleteRecords(table, recordIds, base);
    },
    "Delete records by ID",
    { sideEffect: "destructive", requiresConfirmation: true }
  ),

  ...cacheCommands<AirtableMCPClient>(),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, AirtableMCPClient, {
    programName: "airtable-cli",
    description: "Airtable database operations via MCP",
  });
}

export { commands };
export type { WrappedField };

