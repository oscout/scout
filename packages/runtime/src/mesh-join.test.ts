import { describe, expect, mock, test } from "bun:test";

import { joinBrokerMesh, leaveBrokerMesh } from "./mesh-join.ts";

describe("mesh join control", () => {
  test("binds before discovery and returns discovered peers", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const request = mock(async (_url: string, path: string, options: { body?: unknown }) => {
      calls.push({ path, body: options.body });
      return path.endsWith("/discover")
        ? { discovered: [{ id: "peer-a" }], probes: ["https://peer-a.test"] }
        : { bind: { scope: "mesh" } };
    });

    await expect(joinBrokerMesh("http://broker.test", request as never)).resolves.toEqual({
      discovered: [{ id: "peer-a" }],
      probes: ["https://peer-a.test"],
      error: null,
    });
    expect(calls).toEqual([
      { path: "/v1/mesh/bind", body: { scope: "mesh" } },
      { path: "/v1/mesh/discover", body: {} },
    ]);
  });

  test("keeps a successful join when peer discovery is unavailable", async () => {
    const request = mock(async (_url: string, path: string) => {
      if (path.endsWith("/discover")) throw new Error("peer probe timed out");
      return { bind: { scope: "mesh" } };
    });

    await expect(joinBrokerMesh("http://broker.test", request as never)).resolves.toEqual({
      discovered: [],
      probes: [],
      error: "peer probe timed out",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("does not discover when the durable bind fails", async () => {
    const request = mock(async () => {
      throw new Error("bind rejected");
    });

    await expect(joinBrokerMesh("http://broker.test", request as never)).rejects.toThrow("bind rejected");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("leaves by binding the broker to local scope", async () => {
    const request = mock(async () => ({ bind: { scope: "local" } }));
    await leaveBrokerMesh("http://broker.test", request as never);
    expect(request).toHaveBeenCalledWith(
      "http://broker.test",
      "/v1/mesh/bind",
      expect.objectContaining({ body: { scope: "local" } }),
    );
  });
});
