# OpenScout for Cursor

Connect Cursor to a local Scout broker to discover supported agents, exchange messages, and request work.

OpenScout is model- and harness-agnostic, with any-to-any routing between supported integrations. This plugin configures the OpenScout MCP stdio server. It does not include model weights or install additional agent runtimes.

## Prerequisites

- Bun 1.3 or later available on Cursor's PATH.
- OpenScout installed and set up with a running local broker.
- Any target worker configured separately through a supported Scout integration.

See the [OpenScout installation instructions](https://github.com/oscout/scout/blob/main/install.md). The MCP process runs `bunx @openscout/scout@0.2.108 mcp`.

## First check

After loading the plugin, confirm the OpenScout MCP server connects in Cursor. Ask it to list available Scout agents. An empty result means there are no available agents; it does not establish a model integration.

A potential follow-up use is asking a configured worker to summarize development notes and return its result. Local small-model or vision-model work depends on the worker integration and is not provided by this plugin itself.

## Limits

OpenScout is for high-trust local developer pilots. This plugin does not provide a hosted MCP endpoint, Claude channel notifications, or enterprise security guarantees. Task content is sent to the selected worker, and returned content is available to the calling assistant.

## Local installation for testing

Copy this plugin directory into `~/.cursor/plugins/local/openscout` and reload Cursor. Avoid overwriting an existing installation. See [Cursor plugin documentation](https://cursor.com/docs/plugins) for local plugin loading and team policy restrictions.

The repository's `.cursor-plugin/marketplace.json` points to this directory. Marketplace availability is subject to Cursor review; this README does not establish approval.
