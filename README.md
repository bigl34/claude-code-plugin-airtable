<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-airtable

Dedicated agent for Airtable database operations with isolated MCP access

![Version](https://img.shields.io/badge/version-1.2.1-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-tables** — List all tables in the base
- **describe-table** — Get table schema
- **list-records** — Query records, optionally projecting selected fields
- **get-record** — Get a single record by ID
- **search-records** — Search records by text with a bounded result count
- **create-record** — Create a new record
- **update-record** — Update an existing record
- **delete-records** — Delete records

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-airtable.git
cd claude-code-plugin-airtable
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- list-tables
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Ensure the MCP server binary is available on your system (see the service's documentation)

## Available Commands

| Command          | Description                                          | Required Options                                                  |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `list-tables`    | List all tables in the base                          | (none)                                                            |
| `describe-table` | Get table schema                                     | `--table`                                                         |
| `list-records`   | Query records, optionally projecting selected fields | `--table`; optional projection `--fields <comma-separated names>` |
| `get-record`     | Get a single record by ID                            | `--table --id`                                                    |
| `search-records` | Search records by text with a bounded result count   | `--table --query`; optional `--limit`                             |
| `create-record`  | Create a new record                                  | `--table --fields`                                                |
| `update-record`  | Update an existing record                            | `--table --id --fields`                                           |
| `delete-records` | Delete records                                       | `--table --id` or `--ids`                                         |

### Common Options

| Option               | Description                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--base <baseId>`    | Airtable base ID (default: YOUR_AIRTABLE_BASE_ID)                                                           |
| `--table <name>`     | Table name (e.g., "Products [ManufacturerName]")                                                            |
| `--id <recordId>`    | Record ID (e.g., recXXXXXXXXXXXXXX)                                                                         |
| `--ids <ids>`        | Comma-separated record IDs                                                                                  |
| `--fields <value>`   | For `list-records`, comma-separated projected field names; for create/update, a JSON object of field values |
| `--filter <formula>` | Airtable filter formula                                                                                     |
| `--query <text>`     | Search term                                                                                                 |
| `--limit <number>`   | Maximum records to return                                                                                   |
| `--view <name>`      | Airtable view name                                                                                          |

## Usage Examples

```bash
# List all tables
npm --prefix "scripts" run cli -- list-tables

# Get table schema
npm --prefix "scripts" run cli -- describe-table --table "Products [ManufacturerName]"

# List products with limit
npm --prefix "scripts" run cli -- list-records --table "Products [ManufacturerName]" --limit 10

# List only the fields needed for the task
npm --prefix "scripts" run cli -- list-records --table "Products [ManufacturerName]" --fields "SerialNumber,Status,Location"

# Search for a product by serial number
npm --prefix "scripts" run cli -- search-records --table "Products [ManufacturerName]" --query "LAAEXMPL00000001" --limit 10

# Get a specific record
npm --prefix "scripts" run cli -- get-record --table "Products [ManufacturerName]" --id recXXXXXXXXXXXXXX

# Create a new record
npm --prefix "scripts" run cli -- create-record --table "Models" --fields '{"Name":"Test Model","Type":"Widget"}'

# Update a record
npm --prefix "scripts" run cli -- update-record --table "Products [ManufacturerName]" --id recXXXXXXXXXXXXXX --fields '{"Status":"Sold"}'

# Filter records with formula
npm --prefix "scripts" run cli -- list-records --table "Products [ManufacturerName]" --filter "{Status}='In Stock'"
```

## How It Works

This plugin wraps an MCP (Model Context Protocol) server, providing a CLI interface that communicates with the service's MCP binary. The CLI translates commands into MCP tool calls and returns structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| MCP connection timeout | Ensure the MCP server binary is installed and accessible |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
