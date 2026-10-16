# Kevin's Pi Setup

This directory contains custom Pi extensions and project-level configuration.

## Custom extensions

Install the custom extensions by dragging their `.ts` files into Pi's extensions directory:

- **Project level:** `.pi/extensions/`
- **Global level:** `~/.pi/agent/extensions/`

Pi automatically discovers TypeScript extensions in either location. Restart Pi, or use `/reload` when available, after adding or changing an extension.

## Other extensions

Extensions installed from npm or other package sources are listed in `.pi/settings.json` under `packages`:

```json
{
  "packages": [
    "npm:pi-mcp-adapter"
  ]
}
```

Add additional package names to that list. These packages will be automatically installed the next time Pi starts, after the project has been trusted.

You can also add a package from the command line with:

```bash
pi install npm:package-name -l
```

The `-l` flag saves the package to the local project settings instead of your global Pi settings.
