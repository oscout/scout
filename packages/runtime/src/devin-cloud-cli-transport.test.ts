import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devinSessionTransport, externalSessionConnections } from "./external-session-transport.js";

const connection = { id: "cloud", ownerId: "owner", agentId: "devin", provider: "devin" as const, organizationId: "org-test", deliveryMode: "cloud_cli" as const };
async function fixture(run: (env: NodeJS.ProcessEnv, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "scout-cloud-cli-test-"));
  const binary = join(directory, "devin");
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'acp') {
  createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line);
    if(m.id===1) console.log(JSON.stringify({id:1,result:{agentCapabilities:{loadSession:true}}}));
    if(m.id===2) console.log(JSON.stringify({id:2,result:{_meta:{
      'cognition.ai/orgId':process.env.TEST_ORG || 'org-test',
      'cognition.ai/url':'https://app.devin.ai/sessions/'+m.params.sessionId.slice(6),
      'cognition.ai/sessionStatus':'running'
    }}}));
  });
} else {
  const path=args[args.indexOf('--prompt-file')+1];
  appendFileSync(process.env.TEST_LOG, JSON.stringify({body:readFileSync(path,'utf8'),path})+'\\n');
  process.exit(Number(process.env.TEST_EXIT || 0));
}
`, { mode: 0o700 });
  try { await run({ ...process.env, OPENSCOUT_DEVIN_CLI_BIN: binary, TEST_LOG: join(directory, "log") }, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("Cloud CLI is opt-in and requires an organization but no API credential", () => {
  expect(externalSessionConnections({ OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: JSON.stringify([connection]) })).toEqual([connection]);
  expect(() => externalSessionConnections({ OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: JSON.stringify([{ ...connection, deliveryMode: "api" }]) })).toThrow();
});
test("Cloud CLI validates identity and delivers the literal prompt to the exact session through a private file", async () => {
  await fixture(async (env, directory) => {
    const transport = devinSessionTransport(connection, env);
    const body = 'Work "quoted"; $(touch nope)\nreplyToken: private';
    expect(await transport.send("abcdef", body)).toEqual({ nativeSessionId: "devin-abcdef", state: "accepted" });
    const records = (await readFile(join(directory, "log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(records[0]).toEqual(["acp", "--cloud"]);
    expect(records[1].slice(0, 3)).toEqual(["--cloud", "--resume", "devin-abcdef"]);
    expect(records[1]).not.toContain(body);
    expect(records[2].body).toBe(body);
    await expect(readFile(records[2].path)).rejects.toThrow();
  });
});
test("Account mismatch fails before sending; nonzero delivery exit remains uncertain", async () => {
  await fixture(async (env, directory) => {
    await expect(devinSessionTransport(connection, { ...env, TEST_ORG: "org-other" }).send("abcdef", "work")).rejects.toMatchObject({ uncertain: false, message: "devin_cli_session_identity_mismatch" });
    expect((await readFile(join(directory, "log"), "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(devinSessionTransport(connection, { ...env, TEST_EXIT: "1" }).send("abcdef", "work")).rejects.toMatchObject({ uncertain: true, message: "devin_cli_delivery_unconfirmed" });
  });
});
