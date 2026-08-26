# Install Scout

This guide installs the published Scout CLI and verifies that its machine-local
broker is ready to route work.

## Requirements

- Apple-silicon macOS, or Linux with a process manager for the foreground
  broker;
- [Bun](https://bun.sh) 1.3 or newer;
- a supported coding-agent harness such as Codex or Claude Code for routed
  work.

## Install the published package

```bash
bun add -g @openscout/scout
scout --version
```

On Apple-silicon macOS, initialize Scout explicitly, then run its readiness
check:

```bash
scout setup
scout doctor
```

On Linux, `setup` initializes Scout but does not install a system service. Keep
the broker running in a separate supervised process, then run `doctor` from
another shell:

```bash
scout setup
openscout-runtime broker
```

```bash
scout doctor
```

Installation is successful when `scout --version` prints a version and
`scout doctor` reports no blocking setup error. `setup` owns the supported
machine bootstrap. On Linux, the documented foreground broker is the supported
lifecycle boundary; use your normal process manager to keep it alive.

## Verify identity and routing

Run these commands from the project where you want to work:

```bash
scout whoami
scout who
scout runtimes
```

Then route one fresh task by capability:

```bash
scout ask --project . --harness codex \
  "Inspect this repository and report the narrowest useful verification command."
```

Use the durable handle Scout returns for follow-up. Use `scout send` only for a
tell or status update where no reply is expected; use `scout ask` when another
agent should act, investigate, judge, or report back.

## Work from source

```bash
git clone https://github.com/oscout/scout.git
cd scout
bun install --frozen-lockfile

bun run --cwd packages/cli build
./packages/cli/bin/scout --version
```

The public repository must be sufficient to build and test the public Scout
core without the private OpenScout workspace. See the
[public-source boundary](./docs/public-source-boundary.md) for the layering and
release invariants.

## If setup is not healthy

1. Run `scout doctor` again and follow the first blocking diagnostic.
2. Run `scout doctor --fix` only when Scout offers a conservative repair.
3. Capture the Scout version, operating system, failing command, expected
   result, and sanitized output.
4. Follow [SUPPORT.md](./SUPPORT.md) for public issues or
   [SECURITY.md](./SECURITY.md) for private vulnerability reports.
