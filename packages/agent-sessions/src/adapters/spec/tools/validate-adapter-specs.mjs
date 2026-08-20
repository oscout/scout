#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATHS = [
  path.join(ROOT_DIR, "adapter-spec.v1.schema.json"),
  path.join(ROOT_DIR, "adapter-spec.v2.schema.json"),
];

const ENUMS = {
  sourceKinds: new Set(["url", "file", "comment", "generated"]),
  upstreamKinds: new Set(["official_protocol", "cli_protocol", "local_implementation", "mixed"]),
  transports: new Set(["jsonrpc-stdio-jsonl", "stream-json-stdio", "subprocess-stream", "http-sse", "in-process", "mixed"]),
  lifecycle: new Set(["stateful_connection", "long_lived_process", "stateless_request"]),
  conversationScope: new Set(["thread", "session", "turn", "none"]),
  resumeSupport: new Set(["required", "optional", "implicit", "unsupported"]),
  turnSteering: new Set(["native_same_turn", "new_turn_only", "implicit_followup", "unknown"]),
  concurrentTurns: new Set(["single", "multi", "unspecified"]),
  persistence: new Set(["process_state", "local_files", "upstream_session_id", "upstream_thread_id", "none"]),
  attachmentSupport: new Set(["none", "native", "embedded", "reference_text"]),
  outputBlocks: new Set(["text", "reasoning", "action", "file", "error", "question"]),
  actionKinds: new Set(["command", "file_change", "subagent", "tool_call"]),
  interactive: new Set(["none", "native"]),
  serverRequestStrategy: new Set(["not_applicable", "reject_unsupported", "resolve_and_reject", "unknown"]),
  conformanceStatus: new Set(["required", "grandfathered"]),
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message, errors) {
  if (!condition) {
    errors.push(message);
  }
}

function assertEnum(value, validValues, label, errors) {
  assert(validValues.has(value), `${label} must be one of: ${Array.from(validValues).join(", ")}`, errors);
}

function assertStringArray(value, label, errors) {
  assert(Array.isArray(value), `${label} must be an array`, errors);
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    assert(isNonEmptyString(entry), `${label} entries must be non-empty strings`, errors);
  }
}

export function validateAdapterSpec(spec, filePath = "<memory>") {
  const errors = [];

  assert(spec && typeof spec === "object" && !Array.isArray(spec), `${filePath}: spec must be an object`, errors);
  if (errors.length > 0) {
    return errors;
  }

  assert(spec.specVersion === "1.0.0" || spec.specVersion === "2.0.0", `${filePath}: specVersion must be "1.0.0" or "2.0.0"`, errors);
  assert(isNonEmptyString(spec.adapterId), `${filePath}: adapterId must be a non-empty string`, errors);
  assert(/^[a-z0-9-]+$/.test(spec.adapterId ?? ""), `${filePath}: adapterId must match ^[a-z0-9-]+$`, errors);
  assert(isNonEmptyString(spec.displayName), `${filePath}: displayName must be a non-empty string`, errors);

  const implementation = spec.implementation ?? {};
  assert(isNonEmptyString(implementation.package), `${filePath}: implementation.package is required`, errors);
  assert(isNonEmptyString(implementation.entrypoint), `${filePath}: implementation.entrypoint is required`, errors);
  assert(isNonEmptyString(implementation.factoryExport), `${filePath}: implementation.factoryExport is required`, errors);

  const upstream = spec.upstream ?? {};
  assertEnum(upstream.kind, ENUMS.upstreamKinds, `${filePath}: upstream.kind`, errors);
  assert(isNonEmptyString(upstream.name), `${filePath}: upstream.name is required`, errors);
  assertEnum(upstream.transport, ENUMS.transports, `${filePath}: upstream.transport`, errors);
  assert(Array.isArray(upstream.sources) && upstream.sources.length > 0, `${filePath}: upstream.sources must be a non-empty array`, errors);
  if (Array.isArray(upstream.sources)) {
    for (const [index, source] of upstream.sources.entries()) {
      assert(source && typeof source === "object" && !Array.isArray(source), `${filePath}: upstream.sources[${index}] must be an object`, errors);
      assertEnum(source?.kind, ENUMS.sourceKinds, `${filePath}: upstream.sources[${index}].kind`, errors);
      assert(isNonEmptyString(source?.ref), `${filePath}: upstream.sources[${index}].ref is required`, errors);
    }
  }

  const sessionModel = spec.sessionModel ?? {};
  assertEnum(sessionModel.lifecycle, ENUMS.lifecycle, `${filePath}: sessionModel.lifecycle`, errors);
  assertEnum(sessionModel.conversationScope, ENUMS.conversationScope, `${filePath}: sessionModel.conversationScope`, errors);
  assertEnum(sessionModel.resumeSupport, ENUMS.resumeSupport, `${filePath}: sessionModel.resumeSupport`, errors);
  assertEnum(sessionModel.turnSteering, ENUMS.turnSteering, `${filePath}: sessionModel.turnSteering`, errors);
  assertEnum(sessionModel.concurrentTurns, ENUMS.concurrentTurns, `${filePath}: sessionModel.concurrentTurns`, errors);
  assert(Array.isArray(sessionModel.persistence), `${filePath}: sessionModel.persistence must be an array`, errors);
  if (Array.isArray(sessionModel.persistence)) {
    for (const entry of sessionModel.persistence) {
      assertEnum(entry, ENUMS.persistence, `${filePath}: sessionModel.persistence entry`, errors);
    }
  }
  if (sessionModel.resumeSupport !== "unsupported") {
    assert(isNonEmptyString(sessionModel.resumeOptionKey) || sessionModel.resumeSupport === "implicit", `${filePath}: sessionModel.resumeOptionKey is required unless resumeSupport is implicit`, errors);
  }

  const capabilities = spec.capabilities ?? {};
  const promptInputs = capabilities.promptInputs ?? {};
  assert(promptInputs.text === true || promptInputs.text === false, `${filePath}: capabilities.promptInputs.text must be boolean`, errors);
  assertEnum(promptInputs.images, ENUMS.attachmentSupport, `${filePath}: capabilities.promptInputs.images`, errors);
  assertEnum(promptInputs.files, ENUMS.attachmentSupport, `${filePath}: capabilities.promptInputs.files`, errors);
  assert(Array.isArray(capabilities.outputBlocks), `${filePath}: capabilities.outputBlocks must be an array`, errors);
  if (Array.isArray(capabilities.outputBlocks)) {
    for (const entry of capabilities.outputBlocks) {
      assertEnum(entry, ENUMS.outputBlocks, `${filePath}: capabilities.outputBlocks entry`, errors);
    }
  }
  assert(Array.isArray(capabilities.actionKinds), `${filePath}: capabilities.actionKinds must be an array`, errors);
  if (Array.isArray(capabilities.actionKinds)) {
    for (const entry of capabilities.actionKinds) {
      assertEnum(entry, ENUMS.actionKinds, `${filePath}: capabilities.actionKinds entry`, errors);
    }
  }
  const streaming = capabilities.streaming ?? {};
  for (const key of ["text", "reasoning", "actionOutput", "actionStatus"]) {
    assert(streaming[key] === true || streaming[key] === false, `${filePath}: capabilities.streaming.${key} must be boolean`, errors);
  }
  const interactive = capabilities.interactive ?? {};
  assertEnum(interactive.questions, ENUMS.interactive, `${filePath}: capabilities.interactive.questions`, errors);
  assertEnum(interactive.approvals, ENUMS.interactive, `${filePath}: capabilities.interactive.approvals`, errors);
  assertEnum(interactive.serverRequests, ENUMS.interactive, `${filePath}: capabilities.interactive.serverRequests`, errors);
  const control = capabilities.control ?? {};
  assert(control.interrupt === true || control.interrupt === false, `${filePath}: capabilities.control.interrupt must be boolean`, errors);
  assert(control.shutdown === true || control.shutdown === false, `${filePath}: capabilities.control.shutdown must be boolean`, errors);

  const nativeProtocol = spec.nativeProtocol ?? {};
  assertStringArray(nativeProtocol.outboundRequests, `${filePath}: nativeProtocol.outboundRequests`, errors);
  assertStringArray(nativeProtocol.outboundNotifications, `${filePath}: nativeProtocol.outboundNotifications`, errors);
  assertStringArray(nativeProtocol.inboundNotifications, `${filePath}: nativeProtocol.inboundNotifications`, errors);
  assertStringArray(nativeProtocol.inboundServerRequests, `${filePath}: nativeProtocol.inboundServerRequests`, errors);
  assertStringArray(nativeProtocol.messageFormats, `${filePath}: nativeProtocol.messageFormats`, errors);
  assertEnum(nativeProtocol.serverRequestStrategy, ENUMS.serverRequestStrategy, `${filePath}: nativeProtocol.serverRequestStrategy`, errors);

  const normalizedSurface = spec.normalizedSurface ?? {};
  assertStringArray(normalizedSurface.adapterMethods, `${filePath}: normalizedSurface.adapterMethods`, errors);
  assertStringArray(normalizedSurface.optionalAdapterMethods, `${filePath}: normalizedSurface.optionalAdapterMethods`, errors);
  assertStringArray(normalizedSurface.emitsPairingEvents, `${filePath}: normalizedSurface.emitsPairingEvents`, errors);

  assertStringArray(spec.limitations, `${filePath}: limitations`, errors);

  if (spec.specVersion === "2.0.0") {
    const conformance = spec.conformance ?? {};
    assertEnum(conformance.status, ENUMS.conformanceStatus, `${filePath}: conformance.status`, errors);
    assert(isNonEmptyString(conformance.normalizerId), `${filePath}: conformance.normalizerId is required`, errors);
    assert(/^[a-z0-9-]+$/.test(conformance.normalizerId ?? ""), `${filePath}: conformance.normalizerId must match ^[a-z0-9-]+$`, errors);
    assertStringArray(conformance.fixtureSets, `${filePath}: conformance.fixtureSets`, errors);
  }

  return errors;
}

async function collectSpecFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSpecFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === "adapter.spec.json") {
      files.push(entryPath);
    }
  }

  return files;
}

export async function validateRepoAdapterSpecs() {
  await Promise.all(SCHEMA_PATHS.map((schemaPath) => fs.readFile(schemaPath, "utf8")));
  const specFiles = await collectSpecFiles(path.resolve(ROOT_DIR, ".."));
  const results = [];

  for (const specFile of specFiles) {
    const raw = await fs.readFile(specFile, "utf8");
    const spec = JSON.parse(raw);
    const errors = validateAdapterSpec(spec, specFile);
    results.push({ specFile, errors });
  }

  return results;
}

async function runCli() {
  const results = await validateRepoAdapterSpecs();
  const failing = results.filter((result) => result.errors.length > 0);

  if (failing.length === 0) {
    process.stdout.write(`Validated ${results.length} adapter spec file(s).\n`);
    return;
  }

  for (const result of failing) {
    process.stderr.write(`${result.specFile}\n`);
    for (const error of result.errors) {
      process.stderr.write(`  - ${error}\n`);
    }
  }

  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
