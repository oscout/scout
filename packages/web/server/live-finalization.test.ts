import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { connectLiveControl, finalizeLiveSession } from "./live-finalization.ts";
import { ScoutRealtimeVoiceAdmission } from "./realtime-voice.ts";

class FakeSocket extends EventTarget {
  closed = false;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  message(value: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) })); }
}
test("server control sends close and accepts only terminal cumulative usage", async () => {
  const socket = new FakeSocket();
  const result = finalizeLiveSession("opaque/id", "test-only", { connect: (url, key) => {
    expect(url).toBe("wss://api.openai.com/v1/live/sessions/opaque%2Fid/attach"); expect(key).toBe("test-only");
    return socket as unknown as WebSocket;
  }, timeoutMs: 100 });
  socket.dispatchEvent(new Event("open"));
  expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "session.close" });
  socket.message({type:"session.usage.updated",usage:{seconds:4}});
  socket.message({type:"session.closed",reason:"close_requested",usage:{seconds:7}});
  expect(await result).toEqual({state:"confirmed",reason:"close_requested",seconds:7});
  expect(socket.closed).toBe(true);
});
test("server control timeout and socket loss remain unconfirmed", async () => {
  for (const close of [false, true]) {
    const socket = new FakeSocket();
    const result = finalizeLiveSession("id", "test-only", {connect: () => socket as unknown as WebSocket,timeoutMs:10});
    if (close) socket.dispatchEvent(new Event("close"));
    expect((await result).state).toBe("unconfirmed"); expect(socket.closed).toBe(true);
  }
});
test("expired and disabled leases retain provider ownership and bounded cleanup evidence", () => {
  const db = new Database(":memory:"); let now = 0;
  const admission = new ScoutRealtimeVoiceAdmission({database:db,now:()=>now,config:{leaseTtlMs:100}});
  const lease = admission.admit(); admission.bindSession(lease.id,"opaque-live");
  expect(admission.sessionsNeedingCleanup()).toEqual([]);
  now = 101;
  expect(admission.sessionsNeedingCleanup()).toEqual([{leaseId:lease.id,sessionId:"opaque-live"}]);
  admission.releaseAll(); expect(admission.sessionForLease(lease.id)?.state).toBe("active");
  const first = admission.reserveFinalization(lease.id)!;
  expect(admission.reserveFinalization(lease.id)).toBeNull();
  admission.recordFinalization(lease.id,{state:"unconfirmed",reason:"timeout"},first.attempt);
  expect(admission.sessionsNeedingCleanup()).toEqual([]);
  now += 30001; expect(admission.sessionsNeedingCleanup()).toHaveLength(1);
  const second = admission.reserveFinalization(lease.id)!;
  admission.recordFinalization(lease.id,{state:"confirmed",reason:"close_requested",seconds:12},second.attempt);
  expect(admission.sessionsNeedingCleanup()).toEqual([]);
  expect(admission.sessionForLease(lease.id)?.state).toBe("confirmed"); db.close();
});


test("Bun control transport sends server authorization headers on an actual local socket", async () => {
  let authorization = "";
  const server = Bun.serve({hostname:"127.0.0.1",port:0,
    fetch(request, server) { authorization = request.headers.get("authorization") ?? ""; if(server.upgrade(request)) return; return new Response(null,{status:400}); },
    websocket: { message(socket) { socket.send(JSON.stringify({type:"session.closed",reason:"close_requested",usage:{seconds:1}})); } },
  });
  try {
    const result = await finalizeLiveSession("test", "fixture-key", {connect: (_url,key)=>connectLiveControl(`ws://127.0.0.1:${server.port}`,key),timeoutMs:1000});
    expect(authorization).toBe("Bearer fixture-key"); expect(result).toEqual({state:"confirmed",reason:"close_requested",seconds:1});
  } finally { server.stop(true); }
});
