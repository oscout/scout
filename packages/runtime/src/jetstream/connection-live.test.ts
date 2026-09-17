import { expect, test } from "bun:test";
import { ScoutJetStreamConnection } from "./connection.js";
import { createIsolatedJetStreamHarness, hasNatsServerBinary } from "./test-support.js";

const live = hasNatsServerBinary() ? test : test.skip;
live("concurrent connect shares one socket and close during setup leaves none", async () => {
  const harness = await createIsolatedJetStreamHarness();
  const first = new ScoutJetStreamConnection({ config: harness.config, name: "concurrent-test" });
  const closing = new ScoutJetStreamConnection({ config: harness.config, name: "closing-test" });
  const connections = async () => {
    const response = await fetch(`http://127.0.0.1:${harness.config.monitorPort}/connz`);
    return (await response.json() as { connections: Array<{ name?: string }> }).connections;
  };
  try {
    await Promise.all(Array.from({ length: 8 }, () => first.connect()));
    expect((await connections()).filter(c => c.name === "concurrent-test")).toHaveLength(1);
    const pending = closing.connect();
    const closed = closing.close();
    const [result] = await Promise.allSettled([pending, closed]);
    expect(result.status).toBe("rejected");
    expect(closing.isConnected()).toBe(false);
    await first.close();
    for (let i = 0; i < 30 && (await connections()).length > 0; i++) await Bun.sleep(20);
    expect(await connections()).toHaveLength(0);
  } finally {
    await Promise.allSettled([first.close(), closing.close()]);
    await harness.dispose();
  }
}, 15000);
