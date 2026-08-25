# Scout diagrams

Architecture diagrams are stored as editable
[`@arach/arc`](https://www.npmjs.com/package/@arach/arc) models and rendered to
README-safe monospace text.

```bash
bun run diagram:readme
```

Commit the Arc JSON source and the refreshed README together. The generated
block is deliberately plain text so it remains legible in GitHub light and dark
themes, terminals, copied agent context, and `llms.txt` consumers.
