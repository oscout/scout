import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redactSecrets,
  registeredSecretCount,
  resetSecretRegistryForTests,
} from "@openscout/agent-sessions/secret-redaction";

import {
  bootstrapSecretRedaction,
  findEnvSchemaPath,
} from "./secret-redaction-bootstrap.ts";

// Fake stand-in values only — never a real credential.
const FAKE_SCHEMA_SECRET = "fake-boot-schema-secret-0123456789";
const FAKE_ENV_SECRET = "fake-boot-env-secret-abcdefgh";

afterEach(() => {
  resetSecretRegistryForTests();
});

function writeTempSchema(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scout-secret-bootstrap-"));
  const schemaPath = join(dir, ".env.schema");
  writeFileSync(schemaPath, contents);
  return schemaPath;
}

describe("findEnvSchemaPath", () => {
  test("finds a schema in a parent directory", () => {
    const schemaPath = writeTempSchema("# @defaultSensitive=true\n");
    const nested = join(schemaPath, "..", "nested", "deeper");
    expect(findEnvSchemaPath(nested)).toBe(schemaPath);
  });

  test("returns null when given an explicit miss", () => {
    expect(findEnvSchemaPath("/")).toBeNull();
  });
});

describe("bootstrapSecretRedaction", () => {
  test("registers declared credential env values from the injected env", async () => {
    const result = await bootstrapSecretRedaction({
      env: { OPENAI_API_KEY: FAKE_ENV_SECRET },
      schemaPath: null,
    });
    expect(result.varlockLoaded).toBe(false);
    expect(redactSecrets(`token was ${FAKE_ENV_SECRET}`)).toBe("token was [redacted]");
  });

  test("registers sensitive schema values but not public ones", async () => {
    const schemaPath = writeTempSchema([
      "# @defaultSensitive=true",
      "",
      `FAKE_BOOT_SECRET=${FAKE_SCHEMA_SECRET}`,
      "# @sensitive=false",
      "FAKE_BOOT_PUBLIC=plain-public-value",
      "",
    ].join("\n"));
    const result = await bootstrapSecretRedaction({ env: {}, schemaPath });
    expect(result.varlockLoaded).toBe(true);
    expect(redactSecrets(`leaked ${FAKE_SCHEMA_SECRET} here`)).toBe("leaked [redacted] here");
    expect(redactSecrets("plain-public-value")).toBe("plain-public-value");
  });

  test("a varlock load failure is swallowed and reported, never thrown", async () => {
    const result = await bootstrapSecretRedaction({
      env: {},
      schemaPath: "/any/schema/path/.env.schema",
      loadSecrets: () => Promise.reject(new Error("boom")),
    });
    expect(result.varlockLoaded).toBe(false);
    expect(result.registered).toBe(registeredSecretCount());
  });
});
