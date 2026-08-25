import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("public release plan is reviewed-source-only and complete-state idempotent", () => {
  const result = plan("0.2.89");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@openscout\/protocol@0\.2\.89/);
  assert.match(result.stdout, /@openscout\/scout@0\.2\.89/);
  assert.match(result.stdout, /apps\/desktop\/src\/shared\/product\.ts: 0\.2\.89/);
  assert.match(result.stdout, /docs\.json: 0\.2\.89/);
  assert.match(result.stdout, /git fetch --no-tags origin refs\/heads\/main/);
  assert.match(result.stdout, /ship-npm\.sh --verify-state/);
  assert.match(result.stdout, /gh workflow run release-package-npm\.yml/);
  assert.match(result.stdout, /download the exact npm integrity receipt/);
  assert.match(result.stdout, /attach that receipt to the final GitHub release/);
  assert.match(result.stdout, /git push --atomic origin HEAD:refs\/heads\/main/);
  assert.doesNotMatch(result.stdout, /ship-npm\.sh --verify-published/);
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
    const result = plan("0.2.89", option);
    assert.notEqual(result.status, 0, option);
    assert.match(result.stderr, /Unsupported release option/, option);
  }
});

test("0.2.89 and later execute only through the GitHub publication authority", () => {
  const result = plan("0.2.89", "--execute", "--yes");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publishes only through .*release-package-npm\.yml/i);
});

test("0.2.89 npm publication rejects a local second authority", () => {
  const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be published by .*release-package-npm\.yml/i);
});

test("0.2.89 GitHub publication refuses legacy npm token authentication", () => {
  const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "oscout/scout",
      GITHUB_WORKFLOW_REF: "oscout/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
      NPM_TOKEN: "legacy-token-must-not-be-used",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires npm trusted publishing; refusing token authentication/i);
});

test("GitHub npm dispatch is disabled for the authority cutover", () => {
  const result = plan("0.2.88", "--github-npm");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled[\s\S]*historical local signed attempt/i);
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

function createRegistryFixture({
  mismatchedGitHead = false,
  completeSet = false,
  receiptState = "matching",
  registryIntegrityMismatch = false,
  protocolLatest = "0.2.87",
  scoutLatest = "0.2.87",
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "scout-npm-state-test."));
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "packages/protocol"), { recursive: true });
  mkdirSync(join(fixture, "packages/cli"), { recursive: true });
  mkdirSync(join(fixture, "fake-bin"), { recursive: true });
  mkdirSync(join(fixture, "release-state"), { recursive: true });
  copyFileSync(new URL("ship-npm.sh", import.meta.url), join(fixture, "scripts/ship-npm.sh"));
  copyFileSync(
    new URL("npm-release-receipt.mjs", import.meta.url),
    join(fixture, "scripts/npm-release-receipt.mjs"),
  );
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
    `#!/bin/bash
if [[ "$1" == "rev-parse" ]]; then
  echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  exit 0
fi
if [[ "$1" == "status" ]]; then exit 0; fi
if [[ "$1" == "remote" && "$2" == "get-url" ]]; then
  echo https://github.com/oscout/scout.git
  exit 0
fi
if [[ "$1" == "ls-remote" ]]; then
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/tags/v0.2.88\\n'
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(fixture, "fake-bin/git"), 0o755);

  const protocolTarball = join(fixture, "release-state/openscout-protocol-0.2.88.tgz");
  const scoutTarball = join(fixture, "release-state/openscout-scout-0.2.88.tgz");
  writeFileSync(protocolTarball, "exact protocol candidate\n");
  writeFileSync(scoutTarball, "exact scout candidate\n");
  const integrity = (path) =>
    "sha512-" + createHash("sha512").update(readFileSync(path)).digest("base64");
  const protocolIntegrity = integrity(protocolTarball);
  const scoutIntegrity = integrity(scoutTarball);
  if (receiptState !== "missing") {
    const receipt = spawnSync(
      process.execPath,
      [
        "scripts/npm-release-receipt.mjs",
        "create",
        "release-state/receipt.json",
        "https://github.com/oscout/scout",
        "0.2.88",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "local-signed",
        "@openscout/protocol",
        "0.2.88",
        protocolTarball,
        "@openscout/scout",
        "0.2.88",
        scoutTarball,
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(receipt.status, 0, receipt.stderr);
    if (receiptState === "tampered") {
      writeFileSync(scoutTarball, "different rebuilt scout candidate\n");
    }
  }

  const observedSha = mismatchedGitHead
    ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(
    join(fixture, "fake-bin/npm"),
    `#!/bin/bash
if [[ "$1" != "view" ]]; then exit 9; fi
identity="$2"
field="$3"
if [[ "$identity" == "@openscout/scout@0.2.88" ]]; then
  if [[ "${completeSet}" != "true" ]]; then
    echo "npm error code E404" >&2
    exit 1
  fi
  case "$field" in
    version) echo 0.2.88 ;;
    gitHead) echo ${observedSha} ;;
    repository.url) echo git+https://github.com/oscout/scout.git ;;
    dist.integrity) echo ${registryIntegrityMismatch ? "sha512-registrymismatch" : scoutIntegrity} ;;
    *) exit 8 ;;
  esac
  exit 0
fi
if [[ "$identity" == "@openscout/protocol@0.2.88" ]]; then
  case "$field" in
    version) echo 0.2.88 ;;
    gitHead) echo ${observedSha} ;;
    repository.url) echo git+https://github.com/oscout/scout.git ;;
    dist.integrity) echo ${protocolIntegrity} ;;
    *) exit 8 ;;
  esac
  exit 0
fi
if [[ "$identity" == "@openscout/protocol" && "$field" == "dist-tags.latest" ]]; then
  echo ${protocolLatest}
  exit 0
fi
if [[ "$identity" == "@openscout/scout" && "$field" == "dist-tags.latest" ]]; then
  echo ${scoutLatest}
  exit 0
fi
exit 7
`,
  );
  chmodSync(join(fixture, "fake-bin/npm"), 0o755);
  return fixture;
}

function registryEnv(fixture) {
  return {
    ...process.env,
    PATH: join(fixture, "fake-bin") + ":" + process.env.PATH,
    GITHUB_ACTIONS: "false",
    NPM_TAG: "latest",
    SCOUT_NPM_RELEASE_STATE_DIR: join(fixture, "release-state"),
  };
}

function createPublishFixture({
  completeSet = false,
  firstUploadIntegrityMismatch = false,
  protocolLatest = completeSet ? "0.2.88" : "0.2.87",
  scoutLatest = completeSet ? "0.2.88" : "0.2.87",
} = {}) {
  const fixture = createRegistryFixture();
  const stateDir = join(fixture, "registry-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "protocol-latest"), protocolLatest);
  writeFileSync(join(stateDir, "scout-latest"), scoutLatest);
  writeFileSync(join(stateDir, "mutations.log"), "");
  if (completeSet) {
    writeFileSync(join(stateDir, "protocol-exists"), "");
    writeFileSync(join(stateDir, "scout-exists"), "");
  }

  const receipt = JSON.parse(readFileSync(join(fixture, "release-state/receipt.json"), "utf8"));
  const protocolReceipt = receipt.packages.find(({ name }) => name === "@openscout/protocol");
  const scoutReceipt = receipt.packages.find(({ name }) => name === "@openscout/scout");
  assert.ok(protocolReceipt && scoutReceipt);
  const protocolIntegrity = firstUploadIntegrityMismatch
    ? "sha512-registrymismatch"
    : protocolReceipt.integrity;

  const npmScript = [
    "#!/bin/bash",
    `fixture=${JSON.stringify(fixture)}`,
    `state_dir=${JSON.stringify(stateDir)}`,
    `protocol_integrity=${JSON.stringify(protocolIntegrity)}`,
    `scout_integrity=${JSON.stringify(scoutReceipt.integrity)}`,
    'command="$1"',
    'if [[ "$command" == "view" ]]; then',
    '  identity="$2"',
    '  field="$3"',
    '  key=""',
    '  if [[ "$identity" == "@openscout/protocol@0.2.88" ]]; then key="protocol"; fi',
    '  if [[ "$identity" == "@openscout/scout@0.2.88" ]]; then key="scout"; fi',
    '  if [[ -n "$key" ]]; then',
    '    if [[ ! -f "$state_dir/${key}-exists" ]]; then echo "npm error code E404" >&2; exit 1; fi',
    '    case "$field" in',
    '      version) echo 0.2.88 ;;',
    '      gitHead) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;',
    '      repository.url) echo git+https://github.com/oscout/scout.git ;;',
    '      dist.integrity) if [[ "$key" == "protocol" ]]; then echo "$protocol_integrity"; else echo "$scout_integrity"; fi ;;',
    '      *) exit 8 ;;',
    '    esac',
    '    exit 0',
    '  fi',
    '  if [[ "$identity" == "@openscout/protocol" && "$field" == "dist-tags.latest" ]]; then cat "$state_dir/protocol-latest"; exit 0; fi',
    '  if [[ "$identity" == "@openscout/scout" && "$field" == "dist-tags.latest" ]]; then cat "$state_dir/scout-latest"; exit 0; fi',
    '  if [[ "$field" == "dist-tags.scout-release-0-2-88" ]]; then echo 0.2.88; exit 0; fi',
    '  exit 7',
    'fi',
    'if [[ "$command" == "publish" ]]; then',
    '  tarball="$2"',
    '  [[ -f "$fixture/release-state/receipt.json" ]] || exit 77',
    '  case "$tarball" in',
    '    "$fixture/release-state/openscout-protocol-0.2.88.tgz") key="protocol" ;;',
    '    "$fixture/release-state/openscout-scout-0.2.88.tgz") key="scout" ;;',
    '    *) exit 78 ;;',
    '  esac',
    '  : > "$state_dir/${key}-exists"',
    '  echo "publish $key" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'if [[ "$command" == "dist-tag" && "$2" == "add" ]]; then',
    '  identity="$3"',
    '  case "$identity" in',
    '    @openscout/protocol@0.2.88) key="protocol" ;;',
    '    @openscout/scout@0.2.88) key="scout" ;;',
    '    *) exit 79 ;;',
    '  esac',
    '  echo 0.2.88 > "$state_dir/${key}-latest"',
    '  echo "promote $key" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'if [[ "$command" == "dist-tag" && "$2" == "rm" ]]; then',
    '  echo "remove-stage $3" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'echo "unexpected npm command: $*" >&2',
    'exit 9',
    "",
  ].join("\n");
  writeFileSync(join(fixture, "fake-bin/npm"), npmScript);
  chmodSync(join(fixture, "fake-bin/npm"), 0o755);
  return { fixture, stateDir };
}

test("registry state fails closed on a partial immutable publication", () => {
  const fixture = createRegistryFixture();
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete npm package set.*cannot be resumed/i);
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
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /published from b+.*expected a+/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry state allows a complete immutable set to finish dist-tag promotion", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    protocolLatest: "0.2.88",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /complete immutable 0\.2\.88 package set/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("complete registry state requires its durable receipt", () => {
  const fixture = createRegistryFixture({ completeSet: true, receiptState: "missing" });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no durable local integrity receipt/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("receipt verification rejects rebuilt or damaged retained bytes", () => {
  const fixture = createRegistryFixture({ completeSet: true, receiptState: "tampered" });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retained candidate (size|SRI) mismatch/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry integrity must exactly match the durable candidate receipt", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    registryIntegrityMismatch: true,
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry integrity does not match the exact reviewed candidate/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("published verification reuses the receipt without rebuilding", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    protocolLatest: "0.2.88",
    scoutLatest: "0.2.88",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-published"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Building packages|Preparing exact publication candidates/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("release receipts are exclusive and cannot be overwritten", () => {
  const fixture = createRegistryFixture();
  try {
    const receiptPath = join(fixture, "release-state/receipt.json");
    const before = readFileSync(receiptPath, "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/npm-release-receipt.mjs",
        "create",
        receiptPath,
        "https://github.com/oscout/scout",
        "0.2.88",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "local-signed",
        "@openscout/protocol",
        "0.2.88",
        join(fixture, "release-state/openscout-protocol-0.2.88.tgz"),
        "@openscout/scout",
        "0.2.88",
        join(fixture, "release-state/openscout-scout-0.2.88.tgz"),
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persist receipt exclusively/i);
    assert.equal(readFileSync(receiptPath, "utf8"), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("publish resumes from retained candidates and records them before npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Building packages|Preparing exact publication candidates/);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.match(mutations, /^publish protocol\npublish scout\n/);
    assert.match(mutations, /promote protocol\npromote scout\n/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("first-upload SRI mismatch stops before the second immutable upload", () => {
  const { fixture, stateDir } = createPublishFixture({ firstUploadIntegrityMismatch: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry integrity does not match the exact reviewed candidate/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a competing local publication lock fails before npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    mkdirSync(join(fixture, "release-state.lock"));
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm release lock already exists/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a fully promoted matching set performs no npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture({ completeSet: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a complete immutable set resumes only the missing mutable promotion", () => {
  const { fixture, stateDir } = createPublishFixture({
    completeSet: true,
    protocolLatest: "0.2.88",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.doesNotMatch(mutations, /publish/);
    assert.doesNotMatch(mutations, /promote protocol/);
    assert.match(mutations, /^promote scout\n/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the isolated retained Scout candidate is normalized and passes the exact audit", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-exact-pack-test."));
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "packages/runtime"), { recursive: true });
    mkdirSync(join(fixture, "candidate/bin"), { recursive: true });
    mkdirSync(join(fixture, "candidate/dist"), { recursive: true });
    copyFileSync(
      new URL("prepare-publish-manifest.mjs", import.meta.url),
      join(fixture, "scripts/prepare-publish-manifest.mjs"),
    );
    copyFileSync(
      new URL("check-packed-manifests.mjs", import.meta.url),
      join(fixture, "scripts/check-packed-manifests.mjs"),
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    writeFileSync(
      join(fixture, "packages/runtime/package.json"),
      JSON.stringify({ name: "@openscout/runtime", version: "0.2.88" }),
    );
    writeFileSync(
      join(fixture, "candidate/package.json"),
      JSON.stringify({
        name: "@openscout/scout",
        version: "0.2.88",
        files: ["bin", "dist", "README.md"],
        bin: { scout: "./bin/scout" },
        devDependencies: { "@openscout/runtime": "workspace:*" },
      }),
    );
    writeFileSync(join(fixture, "candidate/bin/scout"), "#!/bin/sh\n");
    writeFileSync(join(fixture, "candidate/bin/scoutd"), "fixture broker\n");
    writeFileSync(join(fixture, "candidate/dist/main.mjs"), "export {};\n");
    writeFileSync(join(fixture, "candidate/README.md"), "# Scout\n");

    const normalize = spawnSync(
      process.execPath,
      ["scripts/prepare-publish-manifest.mjs", "candidate", fixture],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(normalize.status, 0, normalize.stderr);
    const pack = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", fixture],
      {
        cwd: join(fixture, "candidate"),
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
      },
    );
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = join(fixture, "openscout-scout-0.2.88.tgz");
    const audit = spawnSync(
      process.execPath,
      ["scripts/check-packed-manifests.mjs", "--tarball", tarball],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(audit.status, 0, audit.stderr);
    const packedManifest = spawnSync(
      "tar",
      ["-xOf", tarball, "package/package.json"],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(packedManifest.status, 0, packedManifest.stderr);
    assert.doesNotMatch(packedManifest.stdout, /workspace:/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("npm publication is pinned, staged as a set, and exactly scoped", () => {
  const script = readFileSync(new URL("ship-npm.sh", import.meta.url), "utf8");
  const publishMissing = script.slice(
    script.indexOf("publish_missing_artifacts()"),
    script.indexOf("wait_for_final_tag()"),
  );
  assert.match(script, /PUBLISH_PACKAGES=\(protocol cli\)/);
  assert.match(script, /NPM_REGISTRY_URL="https:\/\/registry\.npmjs\.org"/);
  assert.match(script, /--tag "\$STAGING_NPM_TAG"/);
  assert.match(script, /gitHead/);
  assert.match(script, /repository\.url/);
  assert.match(script, /registry integrity does not match the exact reviewed candidate/);
  assert.match(script, /npm publish "\$tarball"/);
  assert.match(script, /manifest\.gitHead = process\.argv\[2\]/);
  assert.match(script, /exact candidate gitHead/);
  assert.match(script, /prepare-publish-manifest\.mjs "\$pack_root" "\$PWD"/);
  assert.match(script, /check-packed-manifests\.mjs --tarball "\$tarball"/);
  assert.ok(publishMissing.indexOf('wait_for_exact_artifact "$index"') < publishMissing.indexOf('inspect_exact_artifact "$index"'));
  const execution = script.slice(script.indexOf('if [[ "$MODE" == "publish" ]]'));
  assert.ok(execution.indexOf("persist_release_bundle") < execution.indexOf("publish_missing_artifacts"));
  assert.match(script, /npm release lock already exists/);
  assert.match(script, /refusing to overwrite existing npm release bundle/);
  assert.match(script, /incomplete npm package set and cannot be resumed/);
  assert.match(script, /NPM_DIST_TAG_VERIFY_ATTEMPTS="\$\{NPM_DIST_TAG_VERIFY_ATTEMPTS:-60\}"/);
  assert.match(script, /refusing a second local publication authority for v0\.2\.89 and later/);
  assert.match(script, /GITHUB_WORKFLOW_REF/);
  assert.match(script, /requires npm trusted publishing; refusing token authentication/);
  assert.match(script, /assert_canonical_publish_ref/);
  assert.ok(script.indexOf("publish_missing_artifacts") < script.indexOf("promote_package_set"));
});
