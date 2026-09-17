import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRecoveryArgs, recoverLocalRelease } from './recover-local-npm-release.mjs';

const version = '0.2.105', source = 'a'.repeat(40), tooling = 'b'.repeat(40);
const names = ['@openscout/protocol', '@openscout/scout'];
const repository = 'https://github.com/oscout/scout';
const cwd = resolve(new URL('..', import.meta.url).pathname);
const hash = data => createHash('sha256').update(data).digest('hex');
function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function fixture(t) {
  const common = mkdtempSync(join(tmpdir(), 'scout-local-recovery-test.'));
  t.after(() => rmSync(common, { recursive: true, force: true }));
  const bundle = join(common, 'scout-release/npm', `${version}-${source}`);
  mkdirSync(bundle, { recursive: true });
  const triples = [];
  for (let i = 0; i < names.length; i++) {
    const stage = join(common, `stage-${i}`); mkdirSync(join(stage, 'package'), { recursive: true });
    writeFileSync(join(stage, 'package/package.json'), JSON.stringify({ name: names[i], version, gitHead: source, repository: { url: repository } }));
    const file = join(bundle, `candidate-${i}.tgz`);
    execute('tar', ['-czf', file, '-C', stage, 'package']);
    triples.push(names[i], version, file);
  }
  const receiptPath = join(bundle, 'receipt.json');
  execute(process.execPath, [join(cwd, 'scripts/npm-release-receipt.mjs'), 'create', receiptPath, repository, version, source, 'local-signed', ...triples]);
  const receipt = JSON.parse(readFileSync(receiptPath));
  const options = parseRecoveryArgs(['--version', version, '--source', source, '--receipt-sha256', hash(readFileSync(receiptPath)), '--execute', '--yes', '--auth', 'npm-login', '--wait-seconds', '5']);
  const record = i => ({ name: names[i], version, gitHead: source, repository: { url: `git+${repository}.git` }, dist: { integrity: receipt.packages[i].integrity } });
  const state = { records: [record(0), null], tags: [{ latest: '0.2.103', 'scout-release-0-2-105': version }, { latest: '0.2.103' }], dirty: false, remoteTag: source, remoteMain: tooling, calls: [], mutations: [], publishAppears: true };
  const run = (command, args, flags = {}) => {
    state.calls.push([command, args, flags]);
    const ok = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (command === process.execPath || command === 'tar') {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('retained verifier rejected candidate');
      return result;
    }
    if (command === 'git') {
      if (args[0] === 'remote') return ok(repository);
      if (args[0] === 'merge-base') return { status: state.nonAncestor ? 1 : 0 };
      if (args[0] === 'ls-remote') return ok(`${state.remoteMain}\trefs/heads/main\n${state.remoteTag}\trefs/tags/v${version}^{}\n`);
      if (args[0] === 'status') return ok(state.dirty ? ' M scripts/tool.mjs' : '');
      if (args[0] === 'branch') return ok('main');
      if (args[0] === 'show') return ok({ name: args[1].includes('/protocol/') ? names[0] : names[1], version });
      if (args[0] === 'rev-parse') return ok(args.includes('--git-common-dir') ? common : args[1].startsWith('refs/tags') ? source : tooling);
    }
    if (command === 'npm') {
      if (args[0] === 'whoami') return ok('operator');
      if (args[0] === 'view') {
        const i = args[1].startsWith(names[0]) ? 0 : 1;
        if (args[2] === 'dist-tags') return ok(state.tags[i]);
        return state.records[i] ? ok(state.records[i]) : { status: 1, stdout: JSON.stringify({ error: { code: state.registryError ?? 'E404' } }) };
      }
      state.mutations.push(args);
      assert.equal(flags.interactive, true, 'npm mutations must inherit terminal stdio');
      if (args[0] === 'publish') {
        assert.equal(args[1], join(bundle, receipt.packages[1].filename));
        assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--provenance=false'));
        assert.equal(state.tags[0].latest, '0.2.103');
        if (state.publishAppears) state.records[1] = record(1);
      } else if (args[0] === 'dist-tag') {
        assert.ok(state.records.every(Boolean), 'never promote a partial pair');
        state.tags[args[2].startsWith(names[0]) ? 0 : 1].latest = version;
      } else assert.fail(`Unexpected mutation ${args}`);
      return ok('');
    }
    assert.fail(`Unexpected command ${command} ${args}`);
  };
  return { state, options, receiptPath, receipt, bundle, common, run, record, go: () => recoverLocalRelease(options, { cwd, run, sleep: async () => {}, log: () => {} }) };
}

test('protocol-first recovery uploads only retained CLI then promotes verified pair, preserving receipt', async t => {
  const f = fixture(t), before = readFileSync(f.receiptPath);
  await f.go();
  assert.deepEqual(f.state.mutations.map(args => args[0]), ['publish', 'dist-tag', 'dist-tag']);
  assert.deepEqual(f.state.tags.map(tags => tags.latest), [version, version]);
  assert.deepEqual(readFileSync(f.receiptPath), before);
  assert.equal(existsSync(`${f.bundle}.lock`), false);
  assert.ok(!f.state.calls.some(([command, args]) => ['bun', 'bash'].includes(command) || args.includes('build') || args.includes('pack') || args.includes('login')));
});

test('complete exact pair resumes promotion without upload; completed pair is idempotent', async t => {
  const f = fixture(t); f.state.records[1] = f.record(1);
  await f.go(); assert.deepEqual(f.state.mutations.map(args => args[0]), ['dist-tag', 'dist-tag']);
  f.state.mutations.length = 0; await f.go(); assert.equal(f.state.mutations.length, 0);
});

test('read-only plan does not authenticate or mutate', async t => {
  const f = fixture(t); f.options.execute = false;
  await f.go(); assert.equal(f.state.mutations.length, 0);
  assert.ok(!f.state.calls.some(([command, args]) => command === 'npm' && args[0] === 'whoami'));
});

for (const [label, mutate, pattern] of [
  ['missing receipt', f => rmSync(f.receiptPath), /ENOENT/],
  ['wrong receipt digest', f => { f.options.receiptSha256 = '0'.repeat(64); }, /receipt SHA-256/],
  ['changed tarball', f => writeFileSync(join(f.bundle, f.receipt.packages[1].filename), 'changed'), /verifier rejected/],
  ['foreign authority', f => { const receipt = { ...f.receipt, authority: 'github-oidc' }; writeFileSync(f.receiptPath, JSON.stringify(receipt)); f.options.receiptSha256 = hash(readFileSync(f.receiptPath)); }, /verifier rejected/],
  ['CLI-first', f => { f.state.records = [null, f.record(1)]; }, /CLI-first/],
  ['neither artifact', f => { f.state.records = [null, null]; }, /existing exact protocol/],
  ['registry SRI mismatch', f => { f.state.records[0].dist.integrity = 'bad'; }, /identity or SRI/],
  ['registry wrong source', f => { f.state.records[0].gitHead = tooling; }, /identity or SRI/],
  ['registry wrong repository', f => { f.state.records[0].repository.url = 'https://github.com/private/repo'; }, /identity or SRI/],
  ['wrong release tag', f => { f.state.remoteTag = tooling; }, /Remote release tag/],
  ['unreviewed tooling', f => { f.state.remoteMain = source; }, /current public main/],
  ['dirty tooling', f => { f.state.dirty = true; }, /clean reviewed tooling/],
  ['non-ancestor candidate', f => { f.state.nonAncestor = true; }, /ancestor/],
  ['registry network error', f => { f.state.registryError = 'E503'; }, /only an explicit E404/],
  ['newer latest', f => { f.state.tags[0].latest = '0.2.106'; }, /roll back/],
  ['split older latest', f => { f.state.tags[1].latest = '0.2.102'; }, /split older/],
  ['missing protocol staging', f => { delete f.state.tags[0]['scout-release-0-2-105']; }, /staging tag/],
]) {
  test(`rejects ${label} before mutation`, async t => {
    const f = fixture(t); mutate(f);
    await assert.rejects(f.go, pattern); assert.equal(f.state.mutations.length, 0);
  });
}

test('propagation timeout preserves bundle; later retry observes uploaded CLI and never republishes', async t => {
  const f = fixture(t); f.state.publishAppears = false;
  await assert.rejects(f.go, /do not rebuild or bump/);
  assert.equal(f.state.mutations.length, 1); assert.ok(existsSync(f.receiptPath));
  f.state.records[1] = f.record(1); f.state.mutations.length = 0;
  await f.go(); assert.ok(f.state.mutations.every(args => args[0] === 'dist-tag'));
});

test('historical versions and missing confirmation are rejected', () => {
  for (const v of ['0.2.88', '0.2.90', '0.1.999']) assert.throws(() => parseRecoveryArgs(['--version', v]), /frozen/);
  const base = ['--version', version, '--source', source, '--receipt-sha256', 'c'.repeat(64)];
  assert.throws(() => parseRecoveryArgs([...base, '--execute']), /--yes/);
  assert.throws(() => parseRecoveryArgs([...base, '--execute', '--yes']), /--auth npm-login/);
});
