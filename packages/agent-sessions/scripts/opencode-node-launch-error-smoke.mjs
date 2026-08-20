import { createAdapter } from "../dist/adapters/opencode/index.js";

const adapter = createAdapter({
  sessionId: "opencode-node-launch-error-smoke",
  cwd: process.cwd(),
  env: {
    PATH: "/tmp/openscout-missing-bin",
  },
  options: {},
});

const errors = [];
adapter.on("error", (error) => {
  errors.push(error);
});

let timeoutId;
const timeout = new Promise((_, reject) => {
  timeoutId = setTimeout(() => {
    reject(new Error("opencode start did not reject promptly"));
  }, 1_000);
});

let startupError;
try {
  startupError = await Promise.race([
    adapter.start().then(
      () => {
        throw new Error("opencode start unexpectedly resolved");
      },
      (error) => error,
    ),
    timeout,
  ]);
} finally {
  clearTimeout(timeoutId);
}

if (!(startupError instanceof Error)) {
  throw new Error(`expected Error rejection, got ${String(startupError)}`);
}

if (!/ENOENT|not found|did not start/i.test(startupError.message)) {
  throw new Error(`unexpected startup error: ${startupError.message}`);
}

if (errors.length === 0) {
  throw new Error("adapter did not emit the launch error");
}

console.log("ok opencode Node launch error is handled");
