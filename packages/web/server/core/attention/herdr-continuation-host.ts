/**
 * Production wiring for Herdr continuation.
 *
 * Every pane's level is read from the operator's grant file
 * (`$OPENSCOUT_HOME/continuation-policy.json`) on each snapshot. With no file
 * or no matching grant, the pane is `ask`: surfaced as attention, never
 * answered. Keys go out through `herdr agent send-keys` only after an audit
 * row lands in `$OPENSCOUT_HOME/logs/continuation-audit.jsonl`.
 */

import type { HerdrSessionTopology } from "@openscout/protocol";
import {
  appendContinuationAudit,
  claimContinuationActuation,
  createXaiContinuationModel,
  loadContinuationPolicy,
  resolveContinuationGrant,
  type ContinuationModel,
} from "@openscout/runtime";
import { execSystemFile, readHerdrSessions, readHerdrTopology } from "@openscout/runtime/system-probes";

import { herdrTerminalHost } from "../../terminal-hosts/herdr.ts";
import type {
  HerdrContinuationAudit,
  HerdrContinuationCapture,
  HerdrContinuationClaim,
  HerdrContinuationPolicyFor,
  HerdrContinuationSendKeys,
} from "./herdr-continuation.ts";

export type HerdrContinuationHooks = {
  listSessions: () => Promise<readonly { name: string; running?: boolean }[]>;
  readTopology: (sessionName: string) => Promise<HerdrSessionTopology>;
  capture: HerdrContinuationCapture;
  sendKeys?: HerdrContinuationSendKeys;
  model?: ContinuationModel | null;
  policyFor: HerdrContinuationPolicyFor;
  audit: HerdrContinuationAudit;
  claim: HerdrContinuationClaim;
};

export type HerdrContinuationOptions = false | {
  listSessions?: HerdrContinuationHooks["listSessions"];
  readTopology?: HerdrContinuationHooks["readTopology"];
  capture?: HerdrContinuationCapture;
  /** Omit to stay in shadow (notify only). */
  sendKeys?: HerdrContinuationSendKeys;
  model?: ContinuationModel | null;
  /** Defaults to the operator's grant file; no grant is `ask`. */
  policyFor?: HerdrContinuationPolicyFor;
  audit?: HerdrContinuationAudit;
  claim?: HerdrContinuationClaim;
};

export function isBunTestRunner(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  const entry = typeof Bun !== "undefined" ? Bun.main : process.argv[1] ?? "";
  return /[._](test|spec)\.[cm]?[jt]sx?$/.test(entry);
}

/** Grant-file policy: session grant, else project grant, else `ask`. */
export const grantFilePolicyFor: HerdrContinuationPolicyFor = (sessionName, pane) => {
  const policy = loadContinuationPolicy();
  const grant = resolveContinuationGrant(policy, {
    herdrSession: sessionName,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    cwd: pane.cwd,
    foregroundCwd: pane.foregroundCwd,
  });
  return { ...grant, allowModel: policy.allowModel };
};

async function listHerdrSessions(): Promise<readonly { name: string; running?: boolean }[]> {
  return (await readHerdrSessions()).map((session) => ({
    name: session.name,
    running: session.running,
  }));
}

async function defaultCapture(
  sessionName: string,
  pane: { terminalId?: string | null; paneId: string },
): Promise<string | null> {
  return await herdrTerminalHost.capture?.({
    sessionName,
    paneId: pane.terminalId ?? pane.paneId,
  }) ?? null;
}

async function defaultSendKeys(
  sessionName: string,
  target: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) {
    throw new Error("continuation refused to send empty keys");
  }
  await execSystemFile("herdr", ["--session", sessionName, "agent", "send-keys", target, ...keys], {
    timeoutMs: 2_000,
  });
}

export function resolveHerdrContinuationHooks(
  option: HerdrContinuationOptions | undefined,
): HerdrContinuationHooks | null {
  if (option === false) return null;
  // Read from the process, never from the caller, so no caller can claim it.
  const testRunner = isBunTestRunner();
  if (option) {
    // Outside the test runner, injected hooks may shape I/O but never the
    // authority: policy, audit and claim always come from the grant file.
    return {
      listSessions: option.listSessions ?? listHerdrSessions,
      readTopology: option.readTopology ?? readHerdrTopology,
      capture: option.capture ?? defaultCapture,
      ...(option.sendKeys ? { sendKeys: option.sendKeys } : {}),
      ...(option.model ? { model: option.model } : {}),
      policyFor: (testRunner && option.policyFor) || grantFilePolicyFor,
      audit: (testRunner && option.audit) || appendContinuationAudit,
      claim: (testRunner && option.claim) || claimContinuationActuation,
    };
  }
  if (testRunner) return null;
  return {
    listSessions: listHerdrSessions,
    readTopology: readHerdrTopology,
    capture: defaultCapture,
    sendKeys: defaultSendKeys,
    model: createXaiContinuationModel(),
    policyFor: grantFilePolicyFor,
    audit: appendContinuationAudit,
    claim: claimContinuationActuation,
  };
}
