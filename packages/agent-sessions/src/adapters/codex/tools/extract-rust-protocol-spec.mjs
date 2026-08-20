#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanDocLine(line) {
  return line.replace(/^\s*\/\/\/\s?/, "").replace(/^\s*\/\/!\s?/, "").trimEnd();
}

function docLinesToText(lines) {
  return lines.map(cleanDocLine).join("\n").trim();
}

function parseVisibility(signature) {
  const match = signature.match(/^(pub(?:\([^)]*\))?)\b/);
  return match ? match[1] : "private";
}

function shouldIncludeVisibility(visibility, includePrivate) {
  return includePrivate || visibility !== "private";
}

function stripLeadingDocsAndAttrs(entry) {
  return entry
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("///") && !line.startsWith("//!"))
    .join(" ")
    .trim();
}

function splitTopLevelEntries(body) {
  const entries = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let inString = false;
  let inChar = false;
  let escape = false;

  for (const char of body) {
    current += char;

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "'") {
        inChar = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "'") {
      inChar = true;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      continue;
    }

    if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      const cleaned = stripLeadingDocsAndAttrs(current.slice(0, -1));
      if (cleaned) {
        entries.push(cleaned);
      }
      current = "";
    }
  }

  const trailing = stripLeadingDocsAndAttrs(current);
  if (trailing) {
    entries.push(trailing);
  }

  return entries;
}

function findTopLevelDelimiter(source, delimiter) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let inString = false;
  let inChar = false;
  let escape = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "'") {
        inChar = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "'") {
      inChar = true;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === "{") {
      if (delimiter === "{" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
        return index;
      }
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      continue;
    }

    if (char === delimiter && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return index;
    }
  }

  return -1;
}

function splitSignatureAndBody(itemText) {
  const braceIndex = findTopLevelDelimiter(itemText, "{");
  if (braceIndex >= 0) {
    const signature = normalizeWhitespace(itemText.slice(0, braceIndex));
    const body = itemText.slice(braceIndex + 1, itemText.lastIndexOf("}"));
    return { signature, body, kind: "block" };
  }

  const semicolonIndex = findTopLevelDelimiter(itemText, ";");
  if (semicolonIndex >= 0) {
    return {
      signature: normalizeWhitespace(itemText.slice(0, semicolonIndex)),
      body: "",
      kind: "statement",
    };
  }

  return {
    signature: normalizeWhitespace(itemText),
    body: "",
    kind: "statement",
  };
}

function collectItem(lines, startIndex) {
  let text = "";
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let inString = false;
  let inChar = false;
  let escape = false;
  let sawBlock = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    text += `${line}\n`;

    for (const char of line) {
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (inChar) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === "'") {
          inChar = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "'") {
        inChar = true;
        continue;
      }

      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }
      if (char === "<") {
        angleDepth += 1;
        continue;
      }
      if (char === ">") {
        angleDepth = Math.max(0, angleDepth - 1);
        continue;
      }
      if (char === "{") {
        sawBlock = true;
        braceDepth += 1;
        continue;
      }
      if (char === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
    }

    if (sawBlock) {
      if (braceDepth === 0) {
        return { text: text.trimEnd(), endIndex: index };
      }
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0 && angleDepth === 0 && line.includes(";")) {
      return { text: text.trimEnd(), endIndex: index };
    }
  }

  return { text: text.trimEnd(), endIndex: lines.length - 1 };
}

function parseStructFields(body) {
  return splitTopLevelEntries(body).map((entry) => {
    const match = entry.match(/^(pub(?:\([^)]*\))?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    if (!match) {
      return { signature: normalizeWhitespace(entry), name: null, type: null };
    }
    return {
      signature: normalizeWhitespace(entry),
      name: match[2],
      type: normalizeWhitespace(match[3]),
    };
  });
}

function parseEnumVariants(body) {
  return splitTopLevelEntries(body).map((entry) => {
    const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
    return {
      name: match ? match[1] : null,
      signature: normalizeWhitespace(entry),
      shape: match ? normalizeWhitespace(match[2] || "") : "",
    };
  });
}

function parseTopLevelFunction(signature, docs) {
  const match = signature.match(/^(pub(?:\([^)]*\))?\s+)?(?:(async)\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) {
    return null;
  }

  return {
    kind: "function",
    name: match[3],
    visibility: match[1]?.trim() ?? "private",
    async: match[2] === "async",
    signature,
    docs,
  };
}

function parseImplHeader(signature) {
  const match = signature.match(/^impl(?:<[^>]+>)?\s+(?:(.+?)\s+for\s+)?(.+)$/);
  if (!match) {
    return { trait: null, target: signature.replace(/^impl\s+/, "").trim() };
  }
  return {
    trait: match[1] ? normalizeWhitespace(match[1]) : null,
    target: normalizeWhitespace(match[2]),
  };
}

function parseImplMethods(body, includePrivate) {
  const lines = body.split("\n");
  const methods = [];
  let docsBuffer = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("///") && depth === 0) {
      docsBuffer.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#") && depth === 0) {
      continue;
    }

    if (depth === 0 && /^(pub(?:\([^)]*\))?\s+)?(?:(async)\s+)?fn\s+/.test(trimmed)) {
      const item = collectItem(lines, index);
      const { signature } = splitSignatureAndBody(item.text);
      const match = signature.match(/^(pub(?:\([^)]*\))?\s+)?(?:(async)\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (match) {
        const visibility = match[1]?.trim() ?? "private";
        if (shouldIncludeVisibility(visibility, includePrivate)) {
          methods.push({
            name: match[3],
            visibility,
            async: match[2] === "async",
            signature,
            docs: docLinesToText(docsBuffer),
          });
        }
      }
      docsBuffer = [];
      index = item.endIndex;
      continue;
    }

    docsBuffer = [];

    for (const char of rawLine) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }

  return methods;
}

function buildInferredResponsibilities(source, spec) {
  const responsibilities = [];

  const checks = [
    ["initializes a protocol client/session handshake", /\bInitializeParams\b|\binitialize_params\b|\binitialize\b/],
    ["models bidirectional client and server traffic", /\bClientRequest\b|\bClientNotification\b|\bServerRequest\b|\bServerNotification\b/],
    ["requires explicit server-request resolution or rejection", /\bresolve_server_request\b|\breject_server_request\b/],
    ["streams events through a next-event style interface", /\bnext_event\b|\bAppServerEvent\b/],
    ["tracks backpressure or lag on the event stream", /\bLagged\b|\bchannel_capacity\b|\bbackpressure\b/],
    ["manages thread lifecycle calls such as start or resume", /thread\/start|thread\/resume|ThreadStart|ThreadResume/],
    ["defines JSON-RPC wire envelopes or errors", /\bJSONRPC(Request|Response|Notification|Error)\b/],
    ["includes explicit shutdown behavior", /\bshutdown\b|SHUTDOWN_TIMEOUT/],
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(source)) {
      responsibilities.push(label);
    }
  }

  if (spec.protocolImports.length > 0) {
    responsibilities.push(`depends on protocol-facing imports such as ${spec.protocolImports.slice(0, 3).map((entry) => `\`${entry}\``).join(", ")}`);
  }

  return responsibilities;
}

export function parseRustProtocolSpec(source, filePath = "<memory>", options = {}) {
  const includePrivate = options.includePrivate === true;
  const lines = source.split("\n");
  const moduleDocs = [];
  const publicReexports = [];
  const protocolImports = [];
  const types = [];
  const functions = [];
  const impls = [];
  const macros = [];
  let docsBuffer = [];
  let sawTopLevelItem = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (!sawTopLevelItem && moduleDocs.length > 0) {
        moduleDocs.push("");
      }
      continue;
    }

    if (!sawTopLevelItem && trimmed.startsWith("//!")) {
      moduleDocs.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("///")) {
      docsBuffer.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    const isUse = /^(pub\s+)?use\b/.test(trimmed);
    const isImpl = /^impl\b/.test(trimmed);
    const isMacro = /^[A-Za-z_][A-Za-z0-9_:]*!\s*\(/.test(trimmed);
    const isDecl = /^(pub(?:\([^)]*\))?\s+)?(?:(async)\s+)?fn\b|^(pub(?:\([^)]*\))?\s+)?(?:struct|enum|type|const|mod)\b/.test(trimmed);

    if (!isUse && !isImpl && !isMacro && !isDecl) {
      docsBuffer = [];
      continue;
    }

    sawTopLevelItem = true;
    const item = collectItem(lines, index);
    const { signature, body, kind } = splitSignatureAndBody(item.text);
    const docs = docLinesToText(docsBuffer);
    docsBuffer = [];
    index = item.endIndex;

    if (/^pub\s+use\b/.test(signature)) {
      publicReexports.push(signature.replace(/^pub\s+use\s+/, "").trim());
      continue;
    }

    if (/^use\b/.test(signature)) {
      const importTarget = signature.replace(/^use\s+/, "").trim();
      if (/(protocol|jsonrpc|request|notification|server|client)/i.test(importTarget)) {
        protocolImports.push(importTarget);
      }
      continue;
    }

    if (isMacro) {
      macros.push({
        name: signature.split("!")[0],
        signature,
        docs,
      });
      continue;
    }

    if (isImpl) {
      const header = parseImplHeader(signature);
      const methods = parseImplMethods(body, includePrivate);
      impls.push({
        target: header.target,
        trait: header.trait,
        signature,
        docs,
        methods,
      });
      continue;
    }

    const functionItem = parseTopLevelFunction(signature, docs);
    if (functionItem) {
      if (shouldIncludeVisibility(functionItem.visibility, includePrivate)) {
        functions.push(functionItem);
      }
      continue;
    }

    const typeMatch = signature.match(/^(pub(?:\([^)]*\))?\s+)?(struct|enum|type|const|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!typeMatch) {
      continue;
    }

    const visibility = typeMatch[1]?.trim() ?? "private";
    if (!shouldIncludeVisibility(visibility, includePrivate)) {
      continue;
    }

    const itemRecord = {
      kind: typeMatch[2],
      name: typeMatch[3],
      visibility,
      signature,
      docs,
    };

    if (typeMatch[2] === "struct" && kind === "block") {
      types.push({
        ...itemRecord,
        fields: parseStructFields(body),
      });
      continue;
    }

    if (typeMatch[2] === "enum" && kind === "block") {
      types.push({
        ...itemRecord,
        variants: parseEnumVariants(body),
      });
      continue;
    }

    types.push(itemRecord);
  }

  const spec = {
    filePath,
    fileName: path.basename(filePath),
    moduleDocs: docLinesToText(moduleDocs.filter(Boolean)),
    publicReexports,
    protocolImports,
    responsibilities: [],
    types,
    functions,
    impls,
    macros,
  };

  spec.responsibilities = buildInferredResponsibilities(source, spec);
  return spec;
}

export function renderRustProtocolSpecMarkdown(spec) {
  const lines = [];

  lines.push(`# Rust Protocol Spec: ${spec.fileName}`);
  lines.push("");
  lines.push(`- File: \`${spec.filePath}\``);

  if (spec.moduleDocs) {
    lines.push("");
    lines.push("## Module Summary");
    lines.push("");
    lines.push(spec.moduleDocs);
  }

  if (spec.responsibilities.length > 0) {
    lines.push("");
    lines.push("## Inferred Responsibilities");
    lines.push("");
    for (const responsibility of spec.responsibilities) {
      lines.push(`- ${responsibility}`);
    }
  }

  if (spec.protocolImports.length > 0) {
    lines.push("");
    lines.push("## Protocol Imports");
    lines.push("");
    for (const importTarget of spec.protocolImports) {
      lines.push(`- \`${importTarget}\``);
    }
  }

  if (spec.publicReexports.length > 0) {
    lines.push("");
    lines.push("## Public Re-exports");
    lines.push("");
    for (const reexport of spec.publicReexports) {
      lines.push(`- \`${reexport}\``);
    }
  }

  if (spec.types.length > 0) {
    lines.push("");
    lines.push("## Types");
    for (const item of spec.types) {
      lines.push("");
      lines.push(`### \`${item.name}\` ${item.kind}`);
      lines.push("");
      lines.push(`- Visibility: \`${item.visibility}\``);
      lines.push(`- Signature: \`${item.signature}\``);
      if (item.docs) {
        lines.push(`- Docs: ${item.docs.replace(/\n/g, " ")}`);
      }
      if (Array.isArray(item.fields) && item.fields.length > 0) {
        lines.push("- Fields:");
        for (const field of item.fields) {
          lines.push(`  - \`${field.signature}\``);
        }
      }
      if (Array.isArray(item.variants) && item.variants.length > 0) {
        lines.push("- Variants:");
        for (const variant of item.variants) {
          lines.push(`  - \`${variant.signature}\``);
        }
      }
    }
  }

  if (spec.functions.length > 0) {
    lines.push("");
    lines.push("## Top-level Functions");
    lines.push("");
    for (const fn of spec.functions) {
      lines.push(`- \`${fn.signature}\`${fn.docs ? ` — ${fn.docs.replace(/\n/g, " ")}` : ""}`);
    }
  }

  if (spec.impls.length > 0) {
    lines.push("");
    lines.push("## Impl Surface");
    for (const impl of spec.impls) {
      lines.push("");
      lines.push(`### \`${impl.target}\`${impl.trait ? ` via \`${impl.trait}\`` : ""}`);
      lines.push("");
      lines.push(`- Signature: \`${impl.signature}\``);
      if (impl.docs) {
        lines.push(`- Docs: ${impl.docs.replace(/\n/g, " ")}`);
      }
      if (impl.methods.length > 0) {
        lines.push("- Methods:");
        for (const method of impl.methods) {
          lines.push(`  - \`${method.signature}\`${method.docs ? ` — ${method.docs.replace(/\n/g, " ")}` : ""}`);
        }
      }
    }
  }

  if (spec.macros.length > 0) {
    lines.push("");
    lines.push("## Macro Invocations");
    lines.push("");
    for (const macro of spec.macros) {
      lines.push(`- \`${macro.signature}\`${macro.docs ? ` — ${macro.docs.replace(/\n/g, " ")}` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    inputPath: null,
    format: "markdown",
    outputPath: null,
    includePrivate: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      args.format = "json";
      continue;
    }

    if (arg === "--markdown") {
      args.format = "markdown";
      continue;
    }

    if (arg === "--include-private") {
      args.includePrivate = true;
      continue;
    }

    if (arg === "--out") {
      args.outputPath = argv[index + 1] ? path.resolve(argv[index + 1]) : null;
      index += 1;
      continue;
    }

    if (!args.inputPath) {
      args.inputPath = path.resolve(arg);
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.inputPath) {
    throw new Error("Usage: node scripts/extract-rust-protocol-spec.mjs <file.rs> [--json|--markdown] [--include-private] [--out <path>]");
  }

  return args;
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const source = await fs.readFile(args.inputPath, "utf8");
  const spec = parseRustProtocolSpec(source, args.inputPath, {
    includePrivate: args.includePrivate,
  });
  const output = args.format === "json"
    ? `${JSON.stringify(spec, null, 2)}\n`
    : renderRustProtocolSpecMarkdown(spec);

  if (args.outputPath) {
    await fs.writeFile(args.outputPath, output, "utf8");
    return;
  }

  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
