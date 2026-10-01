import { spawn, type ChildProcess } from "node:child_process";
import type { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import type { IntegrationWorkerGrant } from "./integration-worker-leases.js";
import { resolveSlackWorkerCommand, slackSecretCommand, type SlackWorkerCommand } from "./slack-worker-process.js";

/** One broker owns all local project workers. No token values in argv or logs. */
export class SlackWorkerSupervisor {
  private readonly children = new Map<string, { child: ChildProcess; grant: IntegrationWorkerGrant }>();
  private readonly retryAfter = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private readonly service: BrokerIntegrationSetupService, private readonly brokerUrl: () => string, private readonly options: { workerCommand?: () => SlackWorkerCommand; secretExecutable?: string } = {}) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 5_000);
    this.timer.unref();
  }
  private terminate(child: ChildProcess): void {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* terminal */ }
  }
  reconcile(): void {
    if (this.stopped) return;
    let wanted;
    try { wanted = this.service.wantedWorkers(); } catch { return; }
    const desired = new Set(wanted.map(operation => operation.id));
    for (const [id, { child }] of this.children) {
      const state = this.service.workers.observe(id)?.state;
      if (!desired.has(id) || state === "expired" || state === "stopped") this.terminate(child);
    }
    for (const operation of wanted) {
      if (this.children.has(operation.id) || (this.retryAfter.get(operation.id) ?? 0) > Date.now()) continue;
      try {
        const command = slackSecretCommand(operation.credentials!.reference, (this.options.workerCommand ?? resolveSlackWorkerCommand)(), ["project-worker"]);
        const { grant } = this.service.claimWorker(operation.id);
        const child = spawn(this.options.secretExecutable ?? command.executable, command.args, {
          detached: process.platform !== "win32", stdio: ["pipe", "ignore", "ignore"],
          env: { ...process.env, SLACK_APP_TOKEN: "", SLACK_BOT_TOKEN: "" },
        });
        this.children.set(operation.id, { child, grant });
        child.stdin!.on("error", () => this.terminate(child));
        child.stdin!.end(JSON.stringify({ operation, grant, brokerUrl: this.brokerUrl() }));
        child.on("error", () => this.terminate(child));
        child.once("close", () => {
          if (this.children.get(operation.id)?.child !== child) return;
          this.children.delete(operation.id);
          this.service.workers.release(grant);
          if (!this.stopped) { try { this.service.recordWorkerFailure(operation.id, "worker_exited"); } catch { /* broker shutting down */ } }
          this.retryAfter.set(operation.id, Date.now() + 10_000);
        });
      } catch {
        try { this.service.recordWorkerFailure(operation.id, "worker_unavailable"); } catch { /* persistence unavailable */ }
        // Never log credential helper output.
        this.retryAfter.set(operation.id, Date.now() + 10_000);
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const exits = [...this.children].map(([, { child, grant }]) => {
      this.service.workers.release(grant);
      const done = new Promise<void>(resolve => child.once("close", () => resolve()));
      this.terminate(child);
      return done;
    });
    await Promise.all(exits);
  }
}
