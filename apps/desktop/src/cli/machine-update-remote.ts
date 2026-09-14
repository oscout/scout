import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSshExec, type SshExec, type SshEnrollTarget } from "@openscout/runtime";
import { loadInstallCandidate } from "./commands/install.ts";

export type RemoteCandidateOptions = {
  target: SshEnrollTarget;
  expectedNodeIds: string[];
  candidate: string;
  dmg: string;
  helperPath?: string;
  exec?: SshExec;
};

export function resolveUpdateHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "update-helper.mjs"),
    resolve(here, "../update-helper.mjs"),
    resolve(here, "../../../../packages/cli/dist/update-helper.mjs"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Packaged remote update helper is missing. Rebuild/reinstall the Scout CLI before a remote candidate update.");
  return found;
}

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

// OpenSSH sends its command through the remote login shell, even when the local
// child was spawned with argv. Only this fixed Python program is shell-quoted;
// all filenames, artifact bytes and expected IDs travel as JSON on stdin.
export const REMOTE_STAGE_SCRIPT = String.raw`
import base64,hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
payload=json.load(sys.stdin)
home=pathlib.Path.home()
base=home/'.openscout/updates'
base.mkdir(parents=True,exist_ok=True)
stage=pathlib.Path(tempfile.mkdtemp(prefix='candidate-',dir=base))
os.chmod(stage,0o700)
try:
 for name in ['update-helper.mjs','receipt.json','OpenScout.dmg']:
  item=payload['files'][name]
  data=base64.b64decode(item['data'],validate=True)
  if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Transferred artifact checksum mismatch: '+name)
  (stage/name).write_bytes(data)
 env=os.environ.copy()
 env['PATH']=str(home/'.bun/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
 bun=shutil.which('bun',path=env['PATH'])
 if not bun:raise RuntimeError('Bun is required on the remote Mac; no installation performed')
 result=subprocess.run([bun,str(stage/'update-helper.mjs'),json.dumps(payload['expectedNodeIds']),str(stage/'receipt.json'),str(stage/'OpenScout.dmg')],env=env,capture_output=True,text=True,timeout=240)
 if result.returncode:
  print(json.dumps({'schema':'openscout.remote-native-update-error.v1','stage':str(stage),'error':result.stderr[-5000:],'exitCode':result.returncode}))
  sys.exit(result.returncode)
 print(result.stdout,end='')
 shutil.rmtree(stage)
except Exception as error:
 print(json.dumps({'schema':'openscout.remote-native-update-error.v1','stage':str(stage),'error':str(error)}))
 sys.exit(1)
`;

export async function runRemoteCandidateInstall(options: RemoteCandidateOptions): Promise<unknown> {
  // Validate before transfer. The remote installer validates the same bytes
  // again and still enforces Apple identity, Gatekeeper and transaction gates.
  const expectedVersion = loadInstallCandidate(options.candidate, options.dmg).tag_name.replace(/^v/, "");
  if (!options.expectedNodeIds.length || !options.expectedNodeIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("Named machine has no Scout node identity to verify remotely");
  }
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(options.target.destination)) {
    throw new Error("Unsupported SSH destination; use an explicit configured hostname alias");
  }
  const files: Record<string, { data: string; sha256: string }> = {};
  for (const [name, path] of [
    ["update-helper.mjs", options.helperPath ?? resolveUpdateHelperPath()],
    ["receipt.json", options.candidate], ["OpenScout.dmg", options.dmg],
  ]) {
    const bytes = readFileSync(path!);
    files[name!] = { data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const argv = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8"];
  if (options.target.port !== undefined) argv.push("-p", String(options.target.port));
  argv.push("--", options.target.destination, "python3 -c " + shellQuote(REMOTE_STAGE_SCRIPT));
  const result = await (options.exec ?? defaultSshExec)({ argv, stdin: JSON.stringify({ files, expectedNodeIds: options.expectedNodeIds }), timeoutMs: 300_000 });
  if (result.exitCode !== 0) throw new Error(`Remote candidate install did not complete: ${result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`}`);
  let receipt: unknown;
  try { receipt = JSON.parse(result.stdout); } catch { throw new Error("Remote installer returned no readable completion receipt; re-probe before retrying"); }
  const value = receipt as { schema?: string; nodeId?: string; wholeSuiteVerified?: unknown; native?: Array<{ action?: string; installed?: string; status?: string }> };
  if (value?.schema !== "openscout.remote-native-update.v1" || !options.expectedNodeIds.includes(value.nodeId ?? "") || value.wholeSuiteVerified !== false) {
    throw new Error("Remote installer receipt identity was not confirmed; re-probe before retrying");
  }
  if (!Array.isArray(value.native) || value.native.length !== 1 || value.native[0]?.action !== "install"
    || value.native[0]?.installed !== expectedVersion || !["installed", "updated", "up-to-date"].includes(value.native[0]?.status ?? "")) {
    throw new Error("Remote native version was not confirmed in the installer receipt; re-probe before retrying");
  }
  return receipt;
}
