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
  const record = i => ({ name: names[i], version, gitHead: source, repository: { url: `git+${repository}.git` }, dist: { integrity: receipt.packages[i].integrity, tarball: `https://registry.npmjs.org/${names[i]}/-/${names[i].split('/').at(-1)}-${version}.tgz` } });
  const state = { records: [record(0), null], tags: [{ latest: '0.2.103', 'scout-release-0-2-105': version }, { latest: '0.2.103' }], dirty: false, remoteTag: source, remoteMain: tooling, calls: [], mutations: [], publishAppears: true, reads: 0, logs: [] };
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
    if (command === 'gh') {
      if (state.publicCandidate) return ok({ tagName: state.publicWrongTag ? 'v0.3.0' : `v${version}`, isDraft: Boolean(state.publicDraft), isPrerelease: !state.publicStable,
        assets: state.publicMissingMarker ? [] : [{ name: 'candidate-receipt.json', size: readFileSync(join(bundle, 'candidate-receipt.json')).length }] });
      if (state.ghPrerelease) return ok({ tagName: `v${version}`, isPrerelease: true });
      if (state.ghStable) return ok({ tagName: `v${version}`, isPrerelease: false });
      if (state.ghUnknown) return { status: 1, stderr: 'connection refused' };
      return { status: 1, stderr: 'release not found' };
    }
    if (command === 'curl') {
      assert.equal(flags.binary, true);
      assert.ok(args.includes('--disable') && args.includes('=https'));
      if (args.at(-1).startsWith(repository)) return { status: 0, stdout: state.publicConflictingMarker ? Buffer.from('foreign marker') : readFileSync(join(bundle, 'candidate-receipt.json')) };
      assert.ok(!args.includes('--location'), 'registry redirects must not be followed');
      const i = args.at(-1).includes('/protocol/') ? 0 : 1;
      let status = state.registryRedirect === i ? '302' : state.initialByte404 === i ? '404' : '200';
      if (i === 1 && state.records[1] && state.pendingBytes > 0) { state.pendingBytes--; status = '404'; }
      if (state.registryTransportError === i) return { status: 7, stdout: Buffer.from('\n000') };
      const bytes = state.corruptDownload === i ? Buffer.from('different registry bytes') : readFileSync(join(bundle, receipt.packages[i].filename));
      return { status: 0, stdout: Buffer.concat([bytes, Buffer.from(`\n${status}`)]) };
    }
    if (command === 'npm') {
      if (args[0] === 'whoami') return ok('operator');
      if (args[0] === 'view') {
        const i = args[1].startsWith(names[0]) ? 0 : 1;
        if (args[2] === 'dist-tags') {
          if (i === 1 && state.pendingStaging > 0) {
            state.pendingStaging--;
            if (!state.pendingStaging) state.tags[1]['scout-release-0-2-105'] = version;
          }
          return ok(state.tags[i]);
        }
        if (i === 0) state.reads++;
        if (i === 1 && state.emptyVersionSuccess) return { status: 0, stdout: '' };
        return state.records[i] ? ok(state.records[i]) : { status: 1, stdout: JSON.stringify({ error: { code: state.registryError ?? 'E404', summary: `No match found for version${version}` } }) };
      }
      state.mutations.push(args);
      assert.equal(flags.interactive, true, 'npm mutations must inherit terminal stdio');
      if (args[0] === 'publish') {
        assert.equal(args[1], join(bundle, receipt.packages[1].filename));
        assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--provenance=false'));
        assert.equal(state.tags[0].latest, '0.2.103');
        state.readsAtUpload = state.reads;
        if (state.publishAppears) {
          state.records[1] = record(1);
          if (!state.pendingStaging) state.tags[1]['scout-release-0-2-105'] = version;
        }
        if (state.changeBaselineAfterUpload) state.tags.forEach(tags => { tags.latest = '0.2.104'; });
        if (state.corruptAfterUpload) state.corruptDownload = 1;
        if (state.publishError) {
          if (state.unknownAfterPublish) state.corruptDownload = 0;
          throw new Error('npm publish failed; private diagnostic suppressed');
        }
      } else if (args[0] === 'dist-tag') {
        assert.ok(state.records.every(Boolean), 'never promote a partial pair');
        state.tags[args[2].startsWith(names[0]) ? 0 : 1].latest = version;
      } else assert.fail(`Unexpected mutation ${args}`);
      return ok('');
    }
    assert.fail(`Unexpected command ${command} ${args}`);
  };
  return { state, options, receiptPath, receipt, bundle, common, run, record, go: () => recoverLocalRelease(options, { cwd, run, sleep: async () => {}, log: value => state.logs.push(value) }) };
}

function candidateFixture(t) {
  const f = fixture(t);
  const markerPath = join(f.bundle, 'candidate-receipt.json');
  writeFileSync(markerPath, JSON.stringify({
    schemaVersion: 1, kind: 'scout-npm-candidate', releaseState: 'CANDIDATE', repository,
    releaseVersion: version, releaseSha: source, authority: 'local-signed', provenance: 'none',
    stagingTag: 'scout-release-0-2-105', integrityReceiptSha256: f.options.receiptSha256, packages: f.receipt.packages,
  }, null, 2) + '\n');
  f.options.phase = 'candidate';
  f.options.candidateReceiptSha256 = hash(readFileSync(markerPath));
  f.markerPath = markerPath;
  return f;
}

test('protocol-first recovery uploads only retained CLI then promotes verified pair, preserving receipt', async t => {
  const f = fixture(t), before = readFileSync(f.receiptPath); f.state.ghStable = true;
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
  ['tampered retained tarball', f => writeFileSync(join(f.bundle, f.receipt.packages[1].filename), 'changed'), /verifier rejected/],
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

test('held candidate recovery uploads only the original Scout tarball and preserves both Latest baselines', async t => {
  const f = candidateFixture(t), receiptBefore = readFileSync(f.receiptPath), markerBefore = readFileSync(f.markerPath);
  await f.go();
  assert.deepEqual(f.state.mutations.map(args => args[0]), ['publish']);
  assert.deepEqual(f.state.tags.map(tags => tags.latest), ['0.2.103', '0.2.103']);
  assert.deepEqual(f.state.tags.map(tags => tags['scout-release-0-2-105']), [version, version]);
  assert.deepEqual(readFileSync(f.receiptPath), receiptBefore);
  assert.deepEqual(readFileSync(f.markerPath), markerBefore);
  assert.equal(JSON.parse(markerBefore).releaseSha, source);
  assert.notEqual(source, tooling);
  assert.ok(f.state.calls.filter(([command]) => command === 'curl').length >= 3, 'anonymous protocol and Scout bytes measured');
  assert.ok(f.state.mutations[0].includes('--@openscout:registry=https://registry.npmjs.org'));
});

test('complete staged candidate skips upload and authentication; read-only plan does not mutate', async t => {
  const f = candidateFixture(t); f.state.records[1] = f.record(1); f.state.tags[1]['scout-release-0-2-105'] = version;
  await f.go();
  assert.equal(f.state.mutations.length, 0);
  assert.ok(!f.state.calls.some(([command, args]) => command === 'npm' && args[0] === 'whoami'));
  f.options.execute = false; await f.go(); assert.equal(f.state.mutations.length, 0);
});

test('candidate recovery waits for Scout staging visibility after exact artifact visibility', async t => {
  const f = candidateFixture(t); f.state.pendingStaging = 5; f.options.waitSeconds = 10;
  await f.go();
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.tags[1]['scout-release-0-2-105'], version);
  assert.ok(f.state.logs.some(value => value.includes('Waiting for registry propagation')));
});

test('candidate recovery waits for canonical tarball 404 after exact metadata before accepting complete bytes', async t => {
  const f = candidateFixture(t); f.state.pendingBytes = 2; f.options.waitSeconds = 10;
  await f.go();
  assert.equal(f.state.mutations.length, 1);
  assert.ok(f.state.logs.some(value => value.includes('Waiting for registry propagation')));
  assert.deepEqual(f.state.tags.map(tags => tags.latest), ['0.2.103', '0.2.103']);
});

for (const [label, setup, pattern] of [
  ['changed older Latest baseline', f => { f.state.changeBaselineAfterUpload = true; }, /latest baseline changed/],
  ['tampered public bytes after upload', f => { f.state.corruptAfterUpload = true; }, /tarball bytes differ/],
]) {
  test(`candidate recovery stops on ${label} without retrying upload or promotion`, async t => {
    const f = candidateFixture(t); setup(f);
    await assert.rejects(f.go, pattern);
    assert.deepEqual(f.state.mutations.map(args => args[0]), ['publish']);
    assert.ok(existsSync(f.markerPath) && existsSync(f.receiptPath));
  });
}

for (const [label, mutate, pattern] of [
  ['already promoted', f => { f.state.tags[0].latest = version; }, /already promoted/],
  ['newer latest', f => { f.state.tags[0].latest = '0.3.0'; }, /roll back/],
  ['missing marker', f => rmSync(f.markerPath), /ENOENT/],
  ['marker digest mismatch', f => { f.options.candidateReceiptSha256 = '0'.repeat(64); }, /candidate receipt SHA-256/],
  ['marker changed source', f => { const m = JSON.parse(readFileSync(f.markerPath)); m.releaseSha = tooling; writeFileSync(f.markerPath, JSON.stringify(m)); f.options.candidateReceiptSha256 = hash(readFileSync(f.markerPath)); }, /disagrees/],
  ['marker changed receipt', f => { const m = JSON.parse(readFileSync(f.markerPath)); m.integrityReceiptSha256 = '0'.repeat(64); writeFileSync(f.markerPath, JSON.stringify(m)); f.options.candidateReceiptSha256 = hash(readFileSync(f.markerPath)); }, /disagrees/],
  ['CLI-first', f => { f.state.records = [null, f.record(1)]; }, /CLI-first/],
  ['foreign tarball host', f => { f.state.records[0].dist.tarball = 'https://other.example/protocol.tgz'; }, /canonical public registry/],
  ['wrong tarball path', f => { f.state.records[0].dist.tarball = 'https://registry.npmjs.org/unrelated.tgz'; }, /exact package\/version path/],
  ['public bytes differ with matching SRI metadata', f => { f.state.corruptDownload = 0; }, /tarball bytes differ/],
  ['foreign redirect despite exact body bytes', f => { f.state.registryRedirect = 0; }, /HTTP 200 without redirects/],
  ['canonical byte 404 before upload', f => { f.state.initialByte404 = 0; }, /HTTP 200 without redirects/],
  ['registry byte transport failure', f => { f.state.registryTransportError = 0; }, /Cannot anonymously read/],
  ['tampered retained tarball', f => writeFileSync(join(f.bundle, f.receipt.packages[1].filename), 'changed'), /verifier rejected/],
  ['unknown registry error', f => { f.state.registryError = 'E503'; }, /only an explicit E404/],
  ['empty successful version response without absence proof', f => { f.state.emptyVersionSuccess = true; }, /JSON/],
  ['required complete pair absent', f => { f.options.requireComplete = true; }, /complete exact published pair/],
  ['promotion partial pair', f => { f.options.phase = 'promote'; }, /complete exact published pair/],
]) {
  test(`held candidate rejects ${label} before mutation`, async t => {
    const f = candidateFixture(t); mutate(f);
    await assert.rejects(f.go, pattern);
    assert.equal(f.state.mutations.length, 0);
  });
}

for (const presentAfterFailure of [false, true]) {
  test(`failed candidate upload reports ${presentAfterFailure ? 'observable exact bytes' : 'not yet observable with unknown outcome'} with one read-only probe and no retry`, async t => {
    const f = candidateFixture(t); f.state.publishError = true; f.state.publishAppears = presentAfterFailure;
    await assert.rejects(f.go, /npm publish failed/);
    assert.equal(f.state.mutations.length, 1);
    assert.equal(f.state.reads - f.state.readsAtUpload, 1);
    assert.match(f.state.logs.at(-1), presentAfterFailure ? /uploaded exact Scout bytes observable/ : /Scout not yet observable; upload outcome unknown/);
    assert.deepEqual(f.state.tags.map(tags => tags.latest), ['0.2.103', '0.2.103']);
  });
}

test('failed candidate upload reports unknown observation without retry or private diagnostics', async t => {
  const f = candidateFixture(t); f.state.publishError = true; f.state.unknownAfterPublish = true;
  await assert.rejects(f.go, /npm publish failed/);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.reads - f.state.readsAtUpload, 1);
  assert.match(f.state.logs.at(-1), /state probe: unknown/);
  assert.doesNotMatch(f.state.logs.join('\n'), /private diagnostic/);
});

test('failed candidate upload with metadata before bytes reports unknown upload outcome after one probe', async t => {
  const f = candidateFixture(t); f.state.publishError = true; f.state.pendingBytes = 1;
  await assert.rejects(f.go, /npm publish failed/);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.reads - f.state.readsAtUpload, 1);
  assert.match(f.state.logs.at(-1), /Scout not yet observable; upload outcome unknown/);
});

test('ordinary stable recovery refuses a marked candidate, a GitHub prerelease and unknown release state', async t => {
  const marked = candidateFixture(t); marked.options.phase = 'release';
  await assert.rejects(marked.go, /Held candidate requires explicit/); assert.equal(marked.state.mutations.length, 0);
  const prerelease = fixture(t); prerelease.state.ghPrerelease = true;
  await assert.rejects(prerelease.go, /Held GitHub prerelease/); assert.equal(prerelease.state.mutations.length, 0);
  const unknown = fixture(t); unknown.state.ghUnknown = true;
  await assert.rejects(unknown.go, /Cannot verify whether/); assert.equal(unknown.state.mutations.length, 0);
});

test('explicit retained promotion requires complete bytes, permits no upload and preserves original receipts', async t => {
  const f = candidateFixture(t); f.options.phase = 'promote'; f.state.records[1] = f.record(1); f.state.tags[1]['scout-release-0-2-105'] = version;
  f.state.publicCandidate = true;
  const before = readFileSync(f.markerPath);
  await f.go();
  assert.deepEqual(f.state.mutations.map(args => args[0]), ['dist-tag', 'dist-tag']);
  assert.deepEqual(readFileSync(f.markerPath), before);
  assert.deepEqual(f.state.tags.map(tags => tags.latest), [version, version]);
  f.state.mutations.length = 0; f.state.publicStable = true; await f.go(); assert.equal(f.state.mutations.length, 0);
});

for (const [label, mutate, pattern] of [
  ['missing release', f => { f.state.publicCandidate = false; }, /gh release failed|JSON/],
  ['draft release', f => { f.state.publicDraft = true; }, /non-draft same-tag/],
  ['wrong tag', f => { f.state.publicWrongTag = true; }, /non-draft same-tag/],
  ['missing public marker', f => { f.state.publicMissingMarker = true; }, /original public candidate receipt/],
  ['conflicting public marker', f => { f.state.publicConflictingMarker = true; }, /Public candidate receipt differs/],
]) {
  test(`direct retained promotion refuses ${label} before authentication or mutation`, async t => {
    const f = candidateFixture(t); f.options.phase = 'promote'; f.state.records[1] = f.record(1); f.state.tags[1]['scout-release-0-2-105'] = version; f.state.publicCandidate = true;
    mutate(f);
    await assert.rejects(f.go, pattern);
    assert.equal(f.state.mutations.length, 0);
    assert.ok(!f.state.calls.some(([command, args]) => command === 'npm' && args[0] === 'whoami'));
  });
}

test('candidate recovery refuses state overrides and requires exact marker digest in its grammar', async t => {
  const f = candidateFixture(t), previous = process.env.SCOUT_NPM_RELEASE_STATE_DIR;
  try {
    process.env.SCOUT_NPM_RELEASE_STATE_DIR = '/alternate';
    await assert.rejects(f.go, /Git-common-directory bundle/);
    assert.equal(f.state.mutations.length, 0);
  } finally {
    if (previous === undefined) delete process.env.SCOUT_NPM_RELEASE_STATE_DIR; else process.env.SCOUT_NPM_RELEASE_STATE_DIR = previous;
  }
  assert.throws(() => parseRecoveryArgs(['--version', version, '--source', source, '--receipt-sha256', 'c'.repeat(64), '--phase', 'candidate']), /candidate-receipt-sha256/);
});
