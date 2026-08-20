import { afterEach, describe, expect, test } from "bun:test";

import {
  patchConsoleForSecrets,
  redactSecrets,
  redactSecretsDeep,
  registerSecretValue,
  registerSecretValues,
  registeredSecretCount,
  registeredSecretSources,
  resetSecretRegistryForTests,
  unpatchConsoleForSecrets,
} from "./secret-redaction.ts";

// Fake stand-in values only. Never register or log a real credential here.
const FAKE_KEY = "fake-test-credential-value-0001";
const FAKE_KEY_B = "fake-other-token-abcdefgh";

afterEach(() => {
  unpatchConsoleForSecrets();
  resetSecretRegistryForTests();
});

describe("registerSecretValue", () => {
  test("ignores empty, non-string, and short values", () => {
    registerSecretValue(undefined);
    registerSecretValue(null);
    registerSecretValue("");
    registerSecretValue("   ");
    registerSecretValue("short");
    expect(registeredSecretCount()).toBe(0);
  });

  test("registers trimmed values once and tracks the source label", () => {
    registerSecretValue(`  ${FAKE_KEY}  `, "test:source");
    registerSecretValue(FAKE_KEY, "test:source");
    expect(registeredSecretCount()).toBe(1);
    expect(registeredSecretSources()).toEqual(["test:source"]);
  });

  test("registerSecretValues registers a collection", () => {
    registerSecretValues([FAKE_KEY, null, FAKE_KEY_B], "test:batch");
    expect(registeredSecretCount()).toBe(2);
  });
});

describe("redactSecrets", () => {
  test("passes text through when the registry is empty", () => {
    expect(redactSecrets(`token ${FAKE_KEY} here`)).toBe(`token ${FAKE_KEY} here`);
  });

  test("redacts every occurrence of a registered value", () => {
    registerSecretValue(FAKE_KEY);
    expect(redactSecrets(`a ${FAKE_KEY} b ${FAKE_KEY}`)).toBe("a [redacted] b [redacted]");
  });

  test("redacts values regardless of the variable name they came from", () => {
    // The `GH` incident: provenance, not the name, marks a value sensitive.
    registerSecretValue(FAKE_KEY, "varlock:GH");
    expect(redactSecrets(`GH=${FAKE_KEY}`)).toBe("GH=[redacted]");
  });

  test("handles regex-special characters in secrets", () => {
    const tricky = "fake.(key)+[with]?$pecial^chars*";
    registerSecretValue(tricky);
    expect(redactSecrets(`leak: ${tricky}!`)).toBe("leak: [redacted]!");
  });

  test("prefers the longer value when one secret prefixes another", () => {
    registerSecretValue("fakeprefix-secret-longer");
    registerSecretValue("fakeprefix-secret");
    expect(redactSecrets("x fakeprefix-secret-longer y")).toBe("x [redacted] y");
  });
});

describe("redactSecretsDeep", () => {
  test("redacts strings nested in arrays and plain objects", () => {
    registerSecretValue(FAKE_KEY);
    const input = {
      outer: [`key is ${FAKE_KEY}`, { inner: FAKE_KEY }],
      count: 3,
      nothing: null,
    };
    const out = redactSecretsDeep(input);
    expect(out.outer[0]).toBe("key is [redacted]");
    expect((out.outer[1] as { inner: string }).inner).toBe("[redacted]");
    expect(out.count).toBe(3);
  });

  test("passes non-plain objects through untouched", () => {
    registerSecretValue(FAKE_KEY);
    const error = new Error(`boom ${FAKE_KEY}`);
    expect(redactSecretsDeep(error)).toBe(error);
  });
});

describe("patchConsoleForSecrets", () => {
  test("scrubs string and Error arguments, restores on unpatch", () => {
    registerSecretValue(FAKE_KEY);
    const logged: unknown[][] = [];
    const spy = (...args: unknown[]) => logged.push(args);
    const original = console.log;
    console.log = spy;
    try {
      patchConsoleForSecrets();
      console.log(`leaked ${FAKE_KEY}`, new Error(`failed with ${FAKE_KEY}`));
      expect(logged[0]?.[0]).toBe("leaked [redacted]");
      expect((logged[0]?.[1] as Error).message).toBe("failed with [redacted]");
      unpatchConsoleForSecrets();
    } finally {
      console.log = original;
    }
  });

  test("is idempotent across repeated patch calls", () => {
    patchConsoleForSecrets();
    const once = console.warn;
    patchConsoleForSecrets();
    expect(console.warn).toBe(once);
  });
});
