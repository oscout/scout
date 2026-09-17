import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { renderScoutWebLoginPage } from "./web-login-page.ts";

async function runPage(statusCode: number, next = "", networkFailure = false) {
  const button = { disabled: false };
  const elements: Record<string, any> = {
    "login-form": { hidden: false, querySelector: () => button, addEventListener() {} },
    token: { focus() {}, value: "" }, error: {}, "sign-in-status": {}, "sign-in-help": { hidden: false },
  };
  const navigations: string[] = [];
  const calls: any[] = [];
  const html = renderScoutWebLoginPage("/api/bootstrap.js");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    location: { href: `http://chat.scout.local/login?next=${encodeURIComponent(next)}`, origin: "http://chat.scout.local", replace: (url: string) => navigations.push(url) },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (...args: any[]) => {
      calls.push(args);
      if (networkFailure) throw new Error("offline");
      return new Response("", { status: statusCode });
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { elements, navigations, calls };
}

describe("login recovery", () => {
  test("local bootstrap signs in without a key and preserves the channel destination", async () => {
    const result = await runPage(200, "/chat?channel=room");
    expect(result.navigations).toEqual(["/chat?channel=room"]);
    expect(result.calls[0][0]).toBe("/api/bootstrap.js");
    expect(result.calls[0][1].credentials).toBe("same-origin");
  });
  test("a remote browser gets a usable key form when automatic sign-in is refused", async () => {
    const result = await runPage(401);
    expect(result.navigations).toEqual([]);
    expect(result.elements["login-form"].hidden).toBe(false);
    expect(result.elements["sign-in-help"].hidden).toBe(false);
  });
  test("network failure restores the form rather than leaving sign-in stuck", async () => {
    const result = await runPage(200, "", true);
    expect(result.elements["login-form"].hidden).toBe(false);
  });
  test("a next parameter cannot redirect off-site or loop through login", async () => {
    for (const next of ["https://attacker.example/", "//attacker.example/", "/\\attacker.example/", "javascript:alert(1)", "/login?next=/login"]) {
      expect((await runPage(200, next)).navigations).toEqual(["/"]);
    }
  });
});
