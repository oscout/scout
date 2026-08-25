#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function assertReleaseIdentity(repository, releaseVersion, releaseSha, authority) {
  if (repository !== "https://github.com/oscout/scout") {
    fail(`unsupported repository ${repository || "(missing)"}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    fail(`invalid release version ${releaseVersion || "(missing)"}`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(releaseSha)) {
    fail(`invalid release SHA ${releaseSha || "(missing)"}`);
  }
  if (!new Set(["local-signed", "github-oidc"]).has(authority)) {
    fail(`unsupported publication authority ${authority || "(missing)"}`);
  }
}

function parsePackageTriples(entries) {
  if (entries.length === 0 || entries.length % 3 !== 0) {
    fail("package arguments must be name/version/tarball triples");
  }
  const names = new Set();
  return Array.from({ length: entries.length / 3 }, (_, index) => {
    const name = entries[index * 3];
    const version = entries[index * 3 + 1];
    const tarballPath = resolve(entries[index * 3 + 2]);
    if (!name.startsWith("@openscout/") || names.has(name)) {
      fail(`invalid or duplicate package name ${name || "(missing)"}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      fail(`invalid package version for ${name}: ${version || "(missing)"}`);
    }
    if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
      fail(`candidate tarball is missing for ${name}: ${tarballPath}`);
    }
    names.add(name);
    return { name, version, tarballPath };
  });
}

function parsePackagePairs(entries) {
  if (entries.length === 0 || entries.length % 2 !== 0) {
    fail("expected package arguments must be name/version pairs");
  }
  const names = new Set();
  return Array.from({ length: entries.length / 2 }, (_, index) => {
    const name = entries[index * 2];
    const version = entries[index * 2 + 1];
    if (!name.startsWith("@openscout/") || names.has(name)) {
      fail(`invalid or duplicate expected package name ${name || "(missing)"}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      fail(`invalid expected package version for ${name}: ${version || "(missing)"}`);
    }
    names.add(name);
    return { name, version };
  });
}

function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  hash.update(readFileSync(path));
  return hash.digest(encoding);
}

function measurements(path) {
  return {
    size: statSync(path).size,
    integrity: `sha512-${hashFile(path, "sha512", "base64")}`,
    sha256: hashFile(path, "sha256", "hex"),
  };
}

function fsyncPath(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createReceipt([
  receiptPath,
  repository,
  releaseVersion,
  releaseSha,
  authority,
  ...entries
]) {
  assertReleaseIdentity(repository, releaseVersion, releaseSha, authority);
  const packages = parsePackageTriples(entries).map(({ name, version, tarballPath }) => {
    if (version !== releaseVersion) {
      fail(`${name} version ${version} is outside release ${releaseVersion}`);
    }
    const filename = basename(tarballPath);
    if (join(dirname(tarballPath), filename) !== tarballPath) {
      fail(`candidate path is not canonical for ${name}`);
    }
    return { name, version, filename, ...measurements(tarballPath) };
  });
  const receipt = {
    schemaVersion: 1,
    repository,
    releaseVersion,
    releaseSha,
    authority,
    packages,
  };
  try {
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(receiptPath, 0o600);
    for (const { tarballPath } of parsePackageTriples(entries)) fsyncPath(tarballPath);
    fsyncPath(receiptPath);
    fsyncPath(dirname(receiptPath));
  } catch (error) {
    fail(`could not persist receipt exclusively: ${error.message}`);
  }
}

function verifyReceipt([
  receiptPath,
  bundleDirectory,
  repository,
  releaseVersion,
  releaseSha,
  authority,
  ...entries
]) {
  assertReleaseIdentity(repository, releaseVersion, releaseSha, authority);
  const expectedPackages = parsePackagePairs(entries);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`could not read receipt ${receiptPath}: ${error.message}`);
  }
  if (receipt.schemaVersion !== 1) fail(`unsupported receipt schema ${receipt.schemaVersion}`);
  if (receipt.repository !== repository) fail(`receipt repository is ${receipt.repository}`);
  if (receipt.releaseVersion !== releaseVersion) fail(`receipt version is ${receipt.releaseVersion}`);
  if (receipt.releaseSha !== releaseSha) fail(`receipt SHA is ${receipt.releaseSha}`);
  if (receipt.authority !== authority) fail(`receipt authority is ${receipt.authority}`);
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== expectedPackages.length) {
    fail(`receipt package count is ${receipt.packages?.length ?? "missing"}`);
  }

  const resolvedBundle = resolve(bundleDirectory);
  const seenNames = new Set();
  const verifiedPackages = [];
  for (let index = 0; index < expectedPackages.length; index += 1) {
    const expected = expectedPackages[index];
    const actual = receipt.packages[index];
    if (!actual || actual.name !== expected.name || actual.version !== expected.version) {
      fail(`receipt package ${index} does not match ${expected.name}@${expected.version}`);
    }
    if (seenNames.has(actual.name)) fail(`receipt repeats ${actual.name}`);
    seenNames.add(actual.name);
    if (typeof actual.filename !== "string" || basename(actual.filename) !== actual.filename) {
      fail(`receipt filename is unsafe for ${actual.name}`);
    }
    const tarballPath = resolve(resolvedBundle, actual.filename);
    if (dirname(tarballPath) !== resolvedBundle) fail(`receipt path escapes bundle for ${actual.name}`);
    if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
      fail(`retained candidate is missing for ${actual.name}`);
    }
    const measured = measurements(tarballPath);
    if (actual.size !== measured.size) fail(`retained candidate size mismatch for ${actual.name}`);
    if (actual.integrity !== measured.integrity) fail(`retained candidate SRI mismatch for ${actual.name}`);
    if (actual.sha256 !== measured.sha256) fail(`retained candidate SHA-256 mismatch for ${actual.name}`);
    verifiedPackages.push(`${actual.integrity}\t${actual.filename}`);
  }
  process.stdout.write(verifiedPackages.join("\n"));
}

switch (command) {
  case "create":
    createReceipt(args);
    break;
  case "verify":
    verifyReceipt(args);
    break;
  default:
    fail("usage: npm-release-receipt.mjs <create|verify> ...");
}
