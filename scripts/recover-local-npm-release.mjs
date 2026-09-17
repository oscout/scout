#!/usr/bin/env node
/** Resume retained local bytes using independently reviewed release tooling. Never builds. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const repository = 'https://github.com/oscout/scout';
const registry = 'https://registry.npmjs.org';
const names = ['@openscout/protocol', '@openscout/scout'];
const dirs = ['packages/protocol', 'packages/cli'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalizeRepository = value => String(value ?? '').replace(/^git\+/, '').replace(/^git@github.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github.com\//, 'https://github.com/').replace(/\.git$/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function requireThat(ok, message) { if (!ok) throw new Error(message); }

export function parseRecoveryArgs(args) {
  const options = { execute: false, yes: false, waitSeconds: 900 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--yes') options.yes = true;
    else if (['--version', '--source', '--receipt-sha256', '--auth', '--wait-seconds'].includes(arg)) {
      requireThat(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${arg}`);
      options[{ '--version': 'version', '--source': 'source', '--receipt-sha256': 'receiptSha256', '--auth': 'auth', '--wait-seconds': 'waitSeconds' }[arg]] = args[++i];
    } else throw new Error(`Unknown recovery option: ${arg}`);
  }
  requireThat(/^\d+\.\d+\.\d+$/.test(options.version ?? ''), 'An exact --version is required.');
  const [major, minor, patch] = options.version.split('.').map(Number);
  requireThat(!(major === 0 && (minor < 2 || (minor === 2 && patch <= 90))), 'Historical versions through 0.2.90 are frozen.');
  requireThat(/^[a-f0-9]{40}$/.test(options.source ?? ''), 'An exact 40-character --source is required.');
  requireThat(/^[a-f0-9]{64}$/.test(options.receiptSha256 ?? ''), 'The original --receipt-sha256 is required.');
  requireThat(!options.execute || options.yes, 'Execution requires --execute --yes.');
  requireThat(options.auth === undefined || options.auth === 'npm-login', 'Only explicit --auth npm-login is supported.');
  requireThat(!options.execute || options.auth === 'npm-login', 'Execution requires --auth npm-login (existing local npm authentication).');
  options.waitSeconds = Number(options.waitSeconds);
  requireThat(Number.isInteger(options.waitSeconds) && options.waitSeconds >= 5 && options.waitSeconds <= 3600, '--wait-seconds must be between 5 and 3600.');
  return options;
}

function runner(cwd, env) {
  return (command, args, { interactive = false, allowFailure = false } = {}) => {
    const result = spawnSync(command, args, {
      cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (!allowFailure && (result.error || result.status !== 0)) {
      // Do not echo subprocess diagnostics: auth tools can include sensitive data.
      throw new Error(`${command} ${args[0]} failed; no automatic mutation retry was attempted.`);
    }
    return result;
  };
}

export function assertRegistryPair(records, receipt, tags) {
  for (let i = 0; i < names.length; i++) {
    const record = records[i];
    if (!record) continue;
    requireThat(record.name === names[i] && record.version === receipt.releaseVersion
      && record.gitHead === receipt.releaseSha && normalizeRepository(record.repository?.url) === repository
      && record.dist?.integrity === receipt.packages[i].integrity,
    `Registry identity or SRI mismatch for ${names[i]}.`);
  }
  requireThat(records[0], records[1] ? 'CLI-first registry state is forbidden.' : 'Recovery requires an existing exact protocol artifact.');
  const target = receipt.releaseVersion;
  const compare = (a, b) => {
    const av = a.split('.').map(Number), bv = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
    return 0;
  };
  const older = new Set();
  for (const value of tags) {
    const latest = value.latest;
    requireThat(/^\d+\.\d+\.\d+$/.test(latest ?? '') && compare(target, latest) >= 0, 'Recovery cannot roll back or replace an invalid latest baseline.');
    if (latest !== target) older.add(latest);
  }
  requireThat(older.size <= 1, 'Recovery refuses a split older latest baseline.');
  const staging = `scout-release-${target.replaceAll('.', '-')}`;
  requireThat(tags[0][staging] === target || tags[0].latest === target, 'Protocol is not at its local staging tag or latest.');
}

export async function recoverLocalRelease(options, dependencies = {}) {
  const cwd = dependencies.cwd ?? root;
  requireThat(process.env.GITHUB_ACTIONS !== 'true', 'Local recovery refuses hosted execution.');
  const env = { ...process.env, NPM_CONFIG_PROVENANCE: 'false', npm_config_provenance: 'false' };
  const run = dependencies.run ?? runner(cwd, env);
  const pause = dependencies.sleep ?? sleep;
  const log = dependencies.log ?? console.log;
  const output = (command, args) => (run(command, args).stdout ?? '').trim();
  const git = (...args) => output('git', args);
  const tag = `v${options.version}`;
  const toolingHead = git('rev-parse', 'HEAD^{commit}');
  const assertSource = () => {
    requireThat(normalizeRepository(git('remote', 'get-url', 'origin')) === repository, 'Recovery requires the canonical public origin.');
    requireThat(git('rev-parse', `refs/tags/${tag}^{commit}`) === options.source, 'Local release tag does not match retained source.');
    const refs = new Map(git('ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').filter(Boolean).map(line => line.trim().split(/\s+/)) .map(([sha, ref]) => [ref, sha]));
    requireThat((refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)) === options.source, 'Remote release tag does not match retained source.');
    // Tooling may be newer than the candidate; candidate identity never comes from HEAD.
    requireThat(run('git', ['merge-base', '--is-ancestor', options.source, toolingHead], { allowFailure: true }).status === 0, 'Original release source must be an ancestor of tooling HEAD.');
    if (options.execute) {
      requireThat(git('status', '--porcelain', '--untracked-files=normal') === '', 'Recovery execution requires clean reviewed tooling.');
      requireThat(git('branch', '--show-current') === 'main' && refs.get('refs/heads/main') === toolingHead
        && git('rev-parse', 'HEAD^{commit}') === toolingHead, 'Recovery tooling must be current public main.');
    }
    for (let i = 0; i < dirs.length; i++) {
      const manifest = JSON.parse(git('show', `${options.source}:${dirs[i]}/package.json`));
      requireThat(manifest.name === names[i] && manifest.version === options.version, 'Original source package identity mismatch.');
    }
  };
  assertSource();
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const bundle = join(common, 'scout-release', 'npm', `${options.version}-${options.source}`);
  const receiptPath = join(bundle, 'receipt.json');
  let receipt;
  const verifyBundle = () => {
    const bytes = readFileSync(receiptPath);
    requireThat(digest(bytes) === options.receiptSha256, 'Original receipt SHA-256 mismatch.');
    receipt = JSON.parse(bytes);
    output(process.execPath, [join(cwd, 'scripts/npm-release-receipt.mjs'), 'verify', receiptPath, bundle,
      repository, options.version, options.source, 'local-signed', names[0], options.version, names[1], options.version]);
    for (const entry of receipt.packages) {
      const manifest = JSON.parse(output('tar', ['-xOf', join(bundle, entry.filename), 'package/package.json']));
      requireThat(manifest.name === entry.name && manifest.version === options.version && manifest.gitHead === options.source
        && normalizeRepository(manifest.repository?.url) === repository, 'Retained package manifest does not match original release.');
    }
  };
  const readJson = args => JSON.parse(output('npm', [...args, '--json', '--registry', registry]));
  const readState = () => {
    const records = names.map(name => {
      const result = run('npm', ['view', `${name}@${options.version}`, '--json', '--registry', registry], { allowFailure: true });
      if (result.status === 0) return JSON.parse(result.stdout);
      let error; try { error = JSON.parse(result.stdout || result.stderr); } catch { /* fail closed */ }
      requireThat(error?.error?.code === 'E404', `Cannot verify registry state for ${name}; only an explicit E404 is absence.`);
      return null;
    });
    const tags = names.map(name => readJson(['view', name, 'dist-tags']));
    assertRegistryPair(records, receipt, tags);
    return { records, tags };
  };
  let locked = false;
  const lock = `${bundle}.lock`;
  try {
    if (options.execute) { mkdirSync(lock); locked = true; }
    verifyBundle();
    let state = readState();
    log(`Verified retained ${options.version} at ${options.source}; ${state.records[1] ? 'both artifacts exist' : 'only CLI upload is missing'}.`);
    if (!options.execute) { log('Read-only recovery plan. Execution requires clean public main and --execute --yes --auth npm-login.'); return; }
    // Inherit the operator's existing npm browser-login configuration; do not read,
    // replace, copy, print, or write credentials. npm owns any interactive challenge.
    requireThat(output('npm', ['whoami', '--registry', registry]).length > 0, 'Existing npm login is required.');
    const mutate = args => run('npm', [...args, '--registry', registry], { interactive: true });
    const waitFor = async predicate => {
      for (let elapsed = 0; elapsed <= options.waitSeconds; elapsed += 5) {
        const observed = readState();
        if (predicate(observed)) return observed;
        if (elapsed < options.waitSeconds) { log(`Waiting for registry propagation (${elapsed + 5}s / ${options.waitSeconds}s).`); await pause(5000); }
      }
      throw new Error('Registry propagation timed out. Keep the original bundle and rerun this exact recovery command; do not rebuild or bump.');
    };
    assertSource(); verifyBundle(); state = readState();
    if (!state.records[1]) {
      mutate(['publish', join(bundle, receipt.packages[1].filename), '--access', 'public', '--tag', `scout-release-${options.version.replaceAll('.', '-')}`, '--ignore-scripts', '--provenance=false']);
      state = await waitFor(value => Boolean(value.records[1]));
    }
    // Both exact immutable artifacts are verified before the first latest mutation.
    requireThat(state.records.every(Boolean), 'Both artifacts must exist before promotion.');
    for (let i = 0; i < names.length; i++) {
      assertSource(); verifyBundle(); state = readState();
      requireThat(state.records.every(Boolean), 'Both artifacts must remain present before promotion.');
      if (state.tags[i].latest !== options.version) mutate(['dist-tag', 'add', `${names[i]}@${options.version}`, 'latest']);
      state = await waitFor(value => value.tags[i].latest === options.version);
    }
    verifyBundle(); assertSource(); state = readState();
    requireThat(state.records.every(Boolean) && state.tags.every(value => value.latest === options.version), 'Final pair verification failed.');
    log(`Verified both exact ${options.version} artifacts and latest tags. Original receipt preserved: ${receiptPath}`);
    log('GitHub release/receipt attachment remains a separate verified release step.');
  } finally {
    if (locked) rmdirSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/recover-local-npm-release.mjs --version <version> --source <original-sha> --receipt-sha256 <original-receipt-digest> [--execute --yes --auth npm-login] [--wait-seconds 900]');
  } else {
    try { await recoverLocalRelease(parseRecoveryArgs(process.argv.slice(2))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
