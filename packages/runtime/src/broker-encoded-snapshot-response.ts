import { setImmediate as yieldTurn } from "node:timers/promises";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import type { RuntimeHttpResponseLike } from "./portable-types.js";
import { encodedBodyReaderFor } from "./broker-message-body-cache.js";
import { asyncMessageRecordView, iterateEncodedMessageRecordsAsync, messageRecordKeys } from "./broker-message-records.js";

/** Experimental encoder: cold JSON bodies enter bounded transport buffers directly. */
export async function writeEncodedBrokerSnapshot(response: RuntimeHttpResponseLike, snapshot: RuntimeRegistrySnapshot,
  options: {signal?:AbortSignal;onFlushedBytes?:(bytes:number)=>void;chunkBytes?:number;drainTimeoutMs?:number;onEncodedRecord?:(record:{collection:string;codeUnits:number;utf8Bytes:number})=>void} = {}): Promise<void> {
  const capacity=options.chunkBytes ?? 64*1024;
  if(!Number.isSafeInteger(capacity)||capacity<4)throw new Error("Snapshot byte buffer must hold at least four bytes");
  let buffer=Buffer.allocUnsafe(capacity),used=0;
  const encoder=new TextEncoder();
  let closed=Boolean(response.destroyed||response.writableEnded);
  let pending:(()=>void)|undefined;
  const onClose=()=>{closed=true;pending?.();};
  const onDrain=()=>pending?.();
  response.on("close",onClose);response.on("error",onClose);response.on("drain",onDrain);
  const flush=async()=> {
    if(closed||used===0)return;
    const value=buffer.subarray(0,used);
    // The transport may retain value after write() returns; never overwrite it.
    buffer=Buffer.allocUnsafe(capacity);used=0;
    if(response.write(value)===false && !closed) await new Promise<void>(resolve=> {
      const timer=setTimeout(()=>{closed=true;response.destroy!();pending?.();},options.drainTimeoutMs ?? 30000);
      timer.unref?.();pending=()=>{clearTimeout(timer);pending=undefined;resolve();};
    });
    if(!closed){await yieldTurn();if(!closed)options.onFlushedBytes?.(value.byteLength);}
  };
  const append=async(value:string)=> {
    let consumed=0;
    while(consumed<value.length&&!closed){
      if(capacity-used<4)await flush();
      if(closed)return;
      const {read,written}=encoder.encodeInto(value.slice(consumed),buffer.subarray(used));
      if(!read)throw new Error("Snapshot UTF-8 encoder made no progress");
      consumed+=read;used+=written;
      if(used===capacity)await flush();
    }
  };
  try {
    if(closed)return;
    response.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    await append("{");let firstCollection=true;
    for(const [collection,records] of Object.entries(snapshot)){
      if(closed)return;
      await append(`${firstCollection?"":","}${JSON.stringify(collection)}:{`);firstCollection=false;
      let firstRecord=true;
      if(collection==='messages' && asyncMessageRecordView(records)) {
        for await(const record of iterateEncodedMessageRecordsAsync(records as RuntimeRegistrySnapshot['messages'],{signal:options.signal})) {
          if(closed)return;
          options.signal?.throwIfAborted();
          const encoded=record.json;
          options.onEncodedRecord?.({collection,codeUnits:encoded.length,utf8Bytes:Buffer.byteLength(encoded)});
          await append(`${firstRecord?"":","}${JSON.stringify(record.id)}:${encoded}`);
          firstRecord=false;
        }
      } else {
      for(const id of messageRecordKeys(records)){
        if(closed)return;
        const record=records[id];const reader=encodedBodyReaderFor(record);
        if(!reader){
          const encoded=JSON.stringify(record);if(encoded===undefined)continue;
          options.onEncodedRecord?.({collection,codeUnits:encoded.length,utf8Bytes:Buffer.byteLength(encoded)});
          await append(`${firstRecord?"":","}${JSON.stringify(id)}:${encoded}`);
        } else {
          const header:Record<string,unknown>={};
          for(const key of Object.keys(record))if(key!=="body")Object.defineProperty(header,key,{value:record[key],enumerable:true,configurable:true,writable:true});
          const encoded=JSON.stringify(header);
          options.onEncodedRecord?.({collection,codeUnits:encoded.length,utf8Bytes:Buffer.byteLength(encoded)});
          await append(`${firstRecord?"":","}${JSON.stringify(id)}:${encoded.slice(0,-1)}${encoded==="{}"?"":","}"body":`);
          while(reader.remaining && !closed){
            if(used===capacity)await flush();
            if(closed)return;
            used+=reader.readInto(buffer,used,capacity-used);
            if(used===capacity)await flush();
          }
          if(closed)return;
          // readInto validates SHA256 before returning the final body bytes.
          await append("}");
        }
        firstRecord=false;
      }
      }
      await append("}");
    }
    await append("}");await flush();if(!closed)response.end();
  }catch(error){response.destroy!();throw error;}
  finally{pending?.();response.off!("close",onClose);response.off!("error",onClose);response.off!("drain",onDrain);}
}
