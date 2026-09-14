import { writeEncodedBrokerSnapshot } from "./broker-encoded-snapshot-response.js";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import type { RuntimeHttpResponseLike } from "./portable-types.js";
import { json } from "./broker-http-helpers.js";
import { messageRecordKeys, asyncMessageRecordView, iterateMessageRecordsAsync, materializeMessageRecords } from "./broker-message-records.js";

/** Stream an already captured registry snapshot; never retain a full encoded response. */
export async function writeBrokerSnapshot(
  response: RuntimeHttpResponseLike,
  snapshot: RuntimeRegistrySnapshot,
  options: { signal?:AbortSignal; onFlushedBytes?: (bytes: number) => void; encodedBodies?: boolean; chunkBytes?: number; drainTimeoutMs?: number; onEncodedRecord?: (record: {collection: string; codeUnits: number; utf8Bytes: number}) => void } = {},
): Promise<void> {
  // Portable adapters without removable listeners cannot safely wait for drain.
  if (!response.off || !response.destroy) {
    json(response, 200, asyncMessageRecordView(snapshot.messages)?{...snapshot,messages:await materializeMessageRecords(snapshot.messages,{signal:options.signal})}:snapshot);
    return;
  }
  if (options.encodedBodies) return writeEncodedBrokerSnapshot(response, snapshot, options);
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  let closed = Boolean(response.destroyed || response.writableEnded);
  let pending: (() => void) | undefined;
  const onClose = () => { closed = true; pending?.(); };
  const onDrain = () => pending?.();
  response.on("close", onClose);
  response.on("error", onClose);
  response.on("drain", onDrain);
  let chunk = "";
  let bytes = 0;
  const flush = async () => {
    if (closed || !chunk) return;
    const value = chunk;
    const encodedBytes = bytes;
    chunk = "";
    bytes = 0;
    if (response.write(value) === false && !closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          closed = true;
          response.destroy!();
          pending?.();
        }, drainTimeoutMs);
        timer.unref?.();
        pending = () => { clearTimeout(timer); pending = undefined; resolve(); };
      });
    }
    if (!closed) {
      await yieldTurn();
      if (!closed) options.onFlushedBytes?.(encodedBytes);
    }
  };
  const append = async (part: string) => {
    chunk += part;
    bytes += Buffer.byteLength(part);
    if (bytes >= chunkBytes) await flush();
  };
  try {
    if (closed) return;
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    await append("{");
    let firstCollection = true;
    for (const [collectionName, records] of Object.entries(snapshot)) {
      if (closed) return;
      await append(`${firstCollection ? "" : ","}${JSON.stringify(collectionName)}:{`);
      firstCollection = false;
      let firstRecord = true;
      // Keys are captured from the detached snapshot, not a live registry iterator.
      if(collectionName==='messages'&&asyncMessageRecordView(records)){
        for await(const record of iterateMessageRecordsAsync(records as RuntimeRegistrySnapshot['messages'],{signal:options.signal})){
          if(closed)return;options.signal?.throwIfAborted();const encoded=JSON.stringify(record);
          options.onEncodedRecord?.({collection:collectionName,codeUnits:encoded.length,utf8Bytes:Buffer.byteLength(encoded)});
          await append(`${firstRecord?'':','}${JSON.stringify(record.id)}:${encoded}`);firstRecord=false;
        }
      }else{
      for (const id of messageRecordKeys(records)) {
        if (closed) return;
        const encoded = JSON.stringify(records[id]);
        if (encoded === undefined) continue;
        options.onEncodedRecord?.({collection: collectionName,codeUnits:encoded.length,utf8Bytes:Buffer.byteLength(encoded)});
        await append(`${firstRecord ? "" : ","}${JSON.stringify(id)}:${encoded}`);
        firstRecord = false;
      }
      }
      await append("}");
    }
    await append("}");
    await flush();
    if (!closed) response.end();
  } catch (error) {
    // Once streaming has started, terminate an incomplete response rather than
    // sending an apparently complete snapshot with missing historical records.
    response.destroy();
    throw error;
  } finally {
    pending?.();
    response.off("close", onClose);
    response.off("error", onClose);
    response.off("drain", onDrain);
  }
}
