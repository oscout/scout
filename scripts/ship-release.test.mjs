import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url);

function plan(...args) {
  return spawnSync(process.execPath, ["scripts/ship-release.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("public release plan is reviewed-source-only and resumable", () => {
  const result = plan("0.2.88");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@openscout\/protocol@0\.2\.88/);
  assert.match(result.stdout, /@openscout\/scout@0\.2\.88/);
  assert.match(result.stdout, /apps\/desktop\/src\/shared\/product\.ts: 0\.2\.88/);
  assert.match(result.stdout, /docs\.json: 0\.2\.88/);
  assert.match(result.stdout, /git fetch --no-tags origin refs\/heads\/main/);
  assert.match(result.stdout, /ship-npm\.sh --verify-state/);
  assert.match(result.stdout, /ship-npm\.sh --verify-published/);
  assert.match(result.stdout, /git push --atomic origin HEAD:refs\/heads\/main/);
  assert.doesNotMatch(result.stdout, /bump-version|git commit|--follow-tags/);
  assert.doesNotMatch(result.stdout, /apps\/macos|appcast|include-ios|\.dmg/i);
});

test("ambiguous mutating and partial-release options are rejected", () => {
  for (const option of [
    "--allow-dirty",
    "--skip-bump",
    "--no-commit",
    "--skip-tag",
    "--skip-push",
    "--skip-npm",
    "--skip-github-release",
  ]) {
    const result = plan("0.2.88", option);
    assert.notEqual(result.status, 0, option);
    assert.match(result.stderr, /Unsupported release option/, option);
  }
});

test("GitHub npm dispatch is disabled for the authority cutover", () => {
  const result = plan("0.2.88", "--github-npm");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled.*local signed publication/i);
});

test("release versions are exact stable semver", () => {
  const result = plan("0.2.88oops");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid stable version/);
});

test("SCOUT_APP_VERSION participates in release lockstep", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-release-source-test."));
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    copyFileSync(new URL("ship-release.mjs", import.meta.url), join(fixture, "scripts/ship-release.mjs"));

    const manifests = [
      ".",
      "apps/desktop",
      "packages/agent-sessions",
      "packages/cli",
      "packages/protocol",
      "packages/runtime",
      "packages/session-trace",
      "packages/session-trace-react",
      "packages/web",
    ];
    for (const directory of manifests) {
      mkdirSync(join(fixture, directory), { recursive: true });
      let name = "fixture-" + directory.replaceAll("/", "-");
      if (directory === "packages/cli") name = "@openscout/scout";
      if (directory === "packages/protocol") name = "@openscout/protocol";
      writeFileSync(
        join(fixture, directory, "package.json"),
        JSON.stringify({ name, version: "0.2.88" }),
      );
    }
    mkdirSync(join(fixture, "apps/desktop/src/shared"), { recursive: true });
    writeFileSync(
      join(fixture, "apps/desktop/src/shared/product.ts"),
      'export const SCOUT_APP_VERSION = process.env.SCOUT_APP_VERSION?.trim() || "0.2.87";\n',
    );
    writeFileSync(join(fixture, "docs.json"), JSON.stringify({ version: "0.2.88" }));

    const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.88"], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /product\.ts=0\.2\.87/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createRegistryFixture({ mismatchedGitHead = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "scout-npm-state-test."));
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "packages/protocol"), { recursive: true });
  mkdirSync(join(fixture, "packages/cli"), { recursive: true });
  mkdirSync(join(fixture, "fake-bin"), { recursive: true });
  copyFileSync(new URL("ship-npm.sh", import.meta.url), join(fixture, "scripts/ship-npm.sh"));
  chmodSync(join(fixture, "scripts/ship-npm.sh"), 0o755);
  writeFileSync(
    join(fixture, "packages/protocol/package.json"),
    JSON.stringify({ name: "@openscout/protocol", version: "0.2.88" }),
  );
  writeFileSync(
    join(fixture, "packages/cli/package.json"),
    JSON.stringify({ name: "@openscout/scout", version: "0.2.88" }),
  );

  writeFileSync(
    join(fixture, "fake-bin/git"),
    "#!/bin/bash\nif [[ \"$1\" == \"rev-parse\" ]]; then echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0; fi\nexit 1\n",
  );
  chmodSync(join(fixture, "fake-bin/git"), 0o755);

  const observedSha = mismatchedGitHead
    ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(
    join(fixture, "fake-bin/npm"),
    `#!/bin/bash
if [[ "$1" != "view" ]]; then exit 9; fi
identity="$2"
field="$3"
if [[ "$identity" == "@openscout/scout@0.2.88" && "$field" == "version" ]]; then
  echo "npm error code E404" >&2
  exit 1
fi
if [[ "$identity" == "@openscout/protocol@0.2.88" ]]; then
  case "$field" in
    version) echo 0.2.88 ;;
    gitHead) echo ${observedSha} ;;
    repository.url) echo git+https://github.com/oscout/scout.git ;;
    dist.integrity) echo sha512-fixture ;;
    *) exit 8 ;;
  esac
  exit 0
fi
if [[ "$identity" == "@openscout/protocol" || "$identity" == "@openscout/scout" ]]; then
  if [[ "$field" == "dist-tags.latest" ]]; then echo 0.2.87; exit 0; fi
fi
exit 7
`,
  );
  chmodSync(join(fixture, "fake-bin/npm"), 0o755);
  return fixture;
}

test("registry state accepts a matching partial publication for resume", () => {
  const fixture = createRegistryFixture();
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(fixture, "fake-bin") + ":" + process.env.PATH,
        NPM_TAG: "latest",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compatible with resumable 0\.2\.88 publication/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry state rejects an existing artifact from another commit", () => {
  const fixture = createRegistryFixture({ mismatchedGitHead: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(fixture, "fake-bin") + ":" + process.env.PATH,
        NPM_TAG: "latest",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /published from b+.*expected a+/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("npm publication is pinned, staged as a set, and exactly scoped", () => {
  const script = readFileSync(new URL("ship-npm.sh", import.meta.url), "utf8");
  assert.match(script, /PUBLISH_PACKAGES=\(protocol cli\)/);
  assert.match(script, /NPM_REGISTRY_URL="https:\/\/registry\.npmjs\.org"/);
  assert.match(script, /--tag "\$STAGING_NPM_TAG"/);
  assert.match(script, /gitHead/);
  assert.match(script, /repository\.url/);
  assert.match(script, /assert_canonical_publish_ref/);
  assert.ok(script.indexOf("publish_missing_artifacts") < script.indexOf("promote_package_set"));
});
