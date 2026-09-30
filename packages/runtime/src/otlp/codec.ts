import protobuf from "protobufjs";
import type { OtlpSignal } from "./sanitize.js";
import { otlpSchema } from "./schema.generated.js";

export type OtlpEncoding = "application/json" | "application/x-protobuf";
export class OtlpDecodeError extends Error {
  constructor() { super("Invalid OTLP request"); }
}
const root = protobuf.Root.fromJSON(otlpSchema).resolveAll();
const names = { traces: ["trace", "Trace"], logs: ["logs", "Logs"], metrics: ["metrics", "Metrics"] } as const;
const rejectedFields = { traces: "rejectedSpans", logs: "rejectedLogRecords", metrics: "rejectedDataPoints" } as const;
const hexLengths: Record<string, number> = { traceId: 32, spanId: 16, parentSpanId: 16 };
const options: protobuf.IConversionOptions = { longs: String, enums: Number, bytes: String, defaults: false };
const wireTypes: Record<string, number> = {
  double: 1, float: 5, int32: 0, uint32: 0, sint32: 0, fixed32: 5, sfixed32: 5,
  int64: 0, uint64: 0, sint64: 0, fixed64: 1, sfixed64: 1, bool: 0, string: 2, bytes: 2,
};

function messageType(signal: OtlpSignal, direction: "Request" | "Response"): protobuf.Type {
  const [namespace, name] = names[signal];
  return root.lookupType(`opentelemetry.proto.collector.${namespace}.v1.Export${name}Service${direction}`);
}
function fail(): never { throw new OtlpDecodeError(); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(field: protobuf.Field, value: unknown): unknown {
  if (field.resolvedType instanceof protobuf.Enum) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail();
    return value;
  }
  if (field.type === "string" || field.type === "bool") {
    if (typeof value !== (field.type === "bool" ? "boolean" : "string")) fail();
    return value;
  }
  if (field.type === "double" || field.type === "float") {
    if (value === "NaN") return NaN;
    if (value === "Infinity") return Infinity;
    if (value === "-Infinity") return -Infinity;
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    return value;
  }
  if (field.type === "bytes") {
    if (typeof value !== "string") fail();
    if (hexLengths[field.name]) {
      if (value !== "" && (value.length !== hexLengths[field.name] || !/^[a-fA-F0-9]+$/.test(value))) fail();
      return Buffer.from(value, "hex");
    }
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) fail();
    return Buffer.from(value, "base64");
  }
  const bits = field.type.endsWith("64") ? 64n : 32n;
  const unsigned = field.type.startsWith("u") || field.type.startsWith("fixed");
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value)
    : typeof value === "string" ? value : "";
  if (!/^-?\d{1,20}$/.test(text)) fail();
  const integer = BigInt(text);
  if (integer < (unsigned ? 0n : -(1n << (bits - 1n)))
    || integer > (unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n)) fail();
  return bits === 64n ? integer.toString() : Number(integer);
}

function validateJson(type: protobuf.Type, value: unknown, depth: number, maxDepth: number): Record<string, unknown> {
  if (depth > maxDepth || !object(value)) fail();
  const out: Record<string, unknown> = {};
  const oneofs = new Set<string>();
  for (const field of type.fieldsArray) {
    const raw = Object.hasOwn(value, field.name) ? value[field.name] : undefined;
    if (raw === undefined || raw === null) continue;
    const oneof = field.partOf?.name;
    if (oneof) {
      if (oneofs.has(oneof)) fail();
      oneofs.add(oneof);
    }
    const convert = (entry: unknown): unknown => field.resolvedType instanceof protobuf.Type
      ? validateJson(field.resolvedType, entry, depth + 1, maxDepth) : scalar(field, entry);
    if (field.map) fail();
    if (field.repeated) {
      if (!Array.isArray(raw)) fail();
      out[field.name] = raw.map(convert);
    } else out[field.name] = convert(raw);
  }
  return out;
}

function preflight(type: protobuf.Type, reader: protobuf.Reader, depth: number, maxDepth: number): void {
  if (depth > maxDepth) fail();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const wire = tag & 7;
    if ((tag >>> 3) === 0 || ![0, 1, 2, 5].includes(wire)) fail();
    const field = type.fieldsById[tag >>> 3];
    if (field) {
      const natural = field.resolvedType instanceof protobuf.Type ? 2
        : field.resolvedType instanceof protobuf.Enum ? 0 : wireTypes[field.type];
      if (wire !== natural && !(field.repeated && wire === 2)) fail();
    }
    if (wire !== 2) { reader.skipType(wire); continue; }
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) fail();
    if (field?.resolvedType instanceof protobuf.Type) {
      const previousEnd = reader.len;
      reader.len = end;
      preflight(field.resolvedType, reader, depth + 1, maxDepth);
      if (reader.pos !== end) fail();
      reader.len = previousEnd;
    } else reader.pos = end;
  }
}

function normalizeBytes(type: protobuf.Type, value: Record<string, unknown>): void {
  for (const field of type.fieldsArray) {
    const raw = value[field.name];
    if (raw === undefined) continue;
    if (field.type === "bytes" && hexLengths[field.name] && typeof raw === "string") {
      const bytes = Buffer.from(raw, "base64");
      if (bytes.length !== 0 && bytes.length * 2 !== hexLengths[field.name]) fail();
      value[field.name] = bytes.toString("hex");
    } else if (field.resolvedType instanceof protobuf.Type) {
      for (const entry of field.repeated ? raw as unknown[] : [raw]) {
        if (object(entry)) normalizeBytes(field.resolvedType, entry);
      }
    }
  }
}

export function decodeOtlpRequest(signal: OtlpSignal, bytes: Uint8Array, encoding: OtlpEncoding, maxDepth: number): Record<string, unknown> {
  try {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) fail();
    const type = messageType(signal, "Request");
    let message: protobuf.Message;
    if (encoding === "application/json") {
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      message = type.fromObject(validateJson(type, input, 0, maxDepth));
    } else {
      preflight(type, protobuf.Reader.create(bytes), 0, maxDepth);
      message = type.decode(bytes);
    }
    const plain = type.toObject(message, options) as Record<string, unknown>;
    normalizeBytes(type, plain);
    return plain;
  } catch { throw new OtlpDecodeError(); }
}

export function encodeOtlpResponse(signal: OtlpSignal, encoding: OtlpEncoding, rejected: number): Uint8Array {
  if (!Number.isSafeInteger(rejected) || rejected < 0) throw new Error("Invalid rejection count");
  const value = rejected === 0 ? {} : { partialSuccess: { [rejectedFields[signal]]: String(rejected) } };
  if (encoding === "application/json") return new TextEncoder().encode(JSON.stringify(value));
  const type = messageType(signal, "Response");
  return type.encode(type.fromObject(value)).finish();
}
