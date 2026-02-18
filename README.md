<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-airtable

Dedicated agent for Airtable database operations with isolated MCP access

![Version](https://img.shields.io/badge/version-1.1.9-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-tables** — List all tables in the base
- **describe-table** — Get table schema
- **list-records** — Query records from a table
- **get-record** — Get a single record by ID
- **search-records** — Search records by text
- **create-record** — Create a new record
- **update-record** — Update an existing record
- **delete-records** — Delete records

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-airtable.git
cd claude-code-plugin-airtable
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-tables
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

| Command          | Description                 | Required Options          |
| ---------------- | --------------------------- | ------------------------- |
| `list-tables`    | List all tables in the base | (none)                    |
| `describe-table` | Get table schema            | `--table`                 |
| `list-records`   | Query records from a table  | `--table`                 |
| `get-record`     | Get a single record by ID   | `--table --id`            |
| `search-records` | Search records by text      | `--table --query`         |
| `create-record`  | Create a new record         | `--table --fields`        |
| `update-record`  | Update an existing record   | `--table --id --fields`   |
| `delete-records` | Delete records              | `--table --id` or `--ids` |

### Common Options

| Option               | Description                                       |
| -------------------- | ------------------------------------------------- |
| `--base <baseId>`    | Airtable base ID (default: YOUR_AIRTABLE_BASE_ID) |
| `--table <name>`     | Table name (e.g., "Products [ManufacturerName]")  |
| `--id <recordId>`    | Record ID (e.g., recXXXXXXXXXXXXXX)               |
| `--ids <ids>`        | Comma-separated record IDs                        |
| `--fields <json>`    | JSON object of field values                       |
| `--filter <formula>` | Airtable filter formula                           |
| `--query <text>`     | Search term                                       |
| `--limit <number>`   | Maximum records to return                         |
| `--view <name>`      | Airtable view name                                |

## Usage Examples

```bash
# List all tables
node /Users/USER/node scripts/dist/cli.js list-tables

# Get table schema
node /Users/USER/node scripts/dist/cli.js describe-table --table "Products [ManufacturerName]"

# List products with limit
node /Users/USER/node scripts/dist/cli.js list-records --table "Products [ManufacturerName]" --limit 10

# Search for a product by serial number
node /Users/USER/node scripts/dist/cli.js search-records --table "Products [ManufacturerName]" --query "LAAEXMPL00000001"

# Get a specific record
node /Users/USER/node scripts/dist/cli.js get-record --table "Products [ManufacturerName]" --id recXXXXXXXXXXXXXX

# Create a new record
node /Users/USER/node scripts/dist/cli.js create-record --table "Models" --fields '{"Name":"Test Model","Type":"Widget"}'

# Update a record
node /Users/USER/node scripts/dist/cli.js update-record --table "Products [ManufacturerName]" --id recXXXXXXXXXXXXXX --fields '{"Status":"Sold"}'

# Filter records with formula
node /Users/USER/node scripts/dist/cli.js list-records --table "Products [ManufacturerName]" --filter "{Status}='In Stock'"
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
