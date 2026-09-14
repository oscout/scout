import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageRecord } from "@openscout/protocol";
import { BrokerMessageBodyCache } from "./broker-message-body-cache.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import { writeBrokerSnapshot } from "./broker-snapshot-response.js";
const owned:Array<{root:string,cache:BrokerMessageBodyCache}>=[];
afterEach(()=>{for(const {root,cache} of owned.splice(0)){cache.close();rmSync(root,{recursive:true,force:true});}});
function makeCache(){const root=mkdtempSync(join(tmpdir(),"scout-encoded-snapshot-"));const cache=new BrokerMessageBodyCache(root,{minBodyBytes:0,encodedSnapshots:true});owned.push({root,cache});return cache;}
function message(id:string,body:string):MessageRecord{return {id,body,conversationId:"conversation",actorId:"agent",originNodeId:"node",class:"agent",visibility:"private",policy:"durable",createdAt:1,metadata:{nested:[true,null,{unicode:"漢字"}],omitted:undefined}};}
class Response extends EventEmitter {
 destroyed=false;writableEnded=false;chunks:Buffer[]=[];stalled=false;writes=0;maxWrite=0;
 writeHead(){}
 write(value:unknown){const chunk=Buffer.isBuffer(value)?value:Buffer.from(String(value));this.chunks.push(chunk);this.maxWrite=Math.max(this.maxWrite,chunk.length);this.writes++;return !this.stalled;}
 end(){this.writableEnded=true;}
 destroy(){this.destroyed=true;this.emit("close");}
 body(){return Buffer.concat(this.chunks).toString("utf8");}
}
test("encoded bodies preserve exact bytes and Unicode across tiny transport boundaries without decoding",async()=> {
 const cache=makeCache();const records=Array.from({length:30},(_,i)=>cache.prepare(message(String(i),'雪🦊"\\\n\ud800'.repeat(i+20))));
 const snapshot=createRuntimeRegistrySnapshot({messages:Object.fromEntries(records.map(r=>[r.id,r]))});
 const expected=JSON.stringify(snapshot);const before=cache.status();
 const response=new Response();await writeBrokerSnapshot(response,snapshot,{encodedBodies:true,chunkBytes:31});
 expect(response.body()).toBe(expected);expect(response.maxWrite).toBeLessThanOrEqual(31);expect(response.writableEnded).toBe(true);
 expect(cache.status().decodedJsonUtf8Bytes).toBe(before.decodedJsonUtf8Bytes);
 expect(response.eventNames()).toEqual([]);
});
test("large body is bounded by output chunks and captured versions survive later prepares",async()=> {
 const cache=makeCache();const old=cache.prepare(message("one","🦊漢字".repeat(300000)));
 const snapshot=createRuntimeRegistrySnapshot({messages:{one:old}});const expected=JSON.stringify(snapshot);
 const response=new Response();response.stalled=true;
 const writing=writeBrokerSnapshot(response,snapshot,{encodedBodies:true,chunkBytes:4096});
 await Bun.sleep(5);expect(response.writes).toBe(1);
 const next=cache.prepare(message("one","new"));expect(next.body).toBe("new");
 response.stalled=false;response.emit("drain");await writing;
 expect(response.body()).toBe(expected);expect(response.maxWrite).toBeLessThanOrEqual(4096);
});
test("concurrent slow readers have independent cursors and never overwrite queued buffers",async()=> {
 const cache=makeCache();const snapshot=createRuntimeRegistrySnapshot({messages:{one:cache.prepare(message("one","漢字🦊".repeat(10000)))}});
 const expected=JSON.stringify(snapshot);const a=new Response(),b=new Response();a.stalled=true;b.stalled=true;
 const first=writeBrokerSnapshot(a,snapshot,{encodedBodies:true,chunkBytes:257});const second=writeBrokerSnapshot(b,snapshot,{encodedBodies:true,chunkBytes:509});
 await Bun.sleep(5);expect(a.writes).toBe(1);expect(b.writes).toBe(1);
 a.stalled=false;a.emit("drain");await first;
 expect(b.writes).toBe(1);b.stalled=false;b.emit("drain");await second;
 expect(a.body()).toBe(expected);expect(b.body()).toBe(expected);
});
for(const corrupt of ["mutate","truncate"]){test(`corrupt cache produces an incomplete failed stream: ${corrupt}`,async()=> {
 const cache=makeCache();const snapshot=createRuntimeRegistrySnapshot({messages:{one:cache.prepare(message("one","a".repeat(20000)))}});
 const fd=(cache as unknown as {fd:number}).fd;if(corrupt==="mutate")writeSync(fd,Buffer.from("b"),0,1,100);else ftruncateSync(fd,100);
 const response=new Response();await expect(writeBrokerSnapshot(response,snapshot,{encodedBodies:true,chunkBytes:1024})).rejects.toThrow("cache is unavailable");
 expect(response.destroyed).toBe(true);expect(response.writableEnded).toBe(false);expect(response.eventNames()).toEqual([]);
});}
test("stall deadline and disconnect release listeners without completing a response",async()=> {
 const cache=makeCache();const snapshot=createRuntimeRegistrySnapshot({messages:{one:cache.prepare(message("one","x".repeat(20000)))}});
 for(const disconnect of [false,true]){const response=new Response();response.stalled=true;const writing=writeBrokerSnapshot(response,snapshot,{encodedBodies:true,chunkBytes:512,drainTimeoutMs:10});if(disconnect){await Bun.sleep(2);response.destroy();}await writing;expect(response.destroyed).toBe(true);expect(response.writableEnded).toBe(false);expect(response.eventNames()).toEqual([]);}
});

test("snapshot byte checkpoints follow drain and preserve exact output and disconnect cleanup",async()=>{
 const cache=makeCache();const snapshot=createRuntimeRegistrySnapshot({messages:{one:cache.prepare(message("one","雪🦊".repeat(1000)))}});
 const expected=JSON.stringify(snapshot);const response=new Response();response.stalled=true;let charged=0;
 const writing=writeBrokerSnapshot(response,snapshot,{encodedBodies:true,chunkBytes:257,onFlushedBytes:bytes=>{charged+=bytes;}});
 await Bun.sleep(5);expect(response.writes).toBe(1);expect(charged).toBe(0);
 response.stalled=false;response.emit("drain");await writing;
 expect(charged).toBe(Buffer.byteLength(expected));expect(response.body()).toBe(expected);
 const disconnected=new Response();disconnected.stalled=true;let abortedCharged=0;
 const aborted=writeBrokerSnapshot(disconnected,snapshot,{encodedBodies:true,chunkBytes:257,onFlushedBytes:bytes=>{abortedCharged+=bytes;}});
 await Bun.sleep(5);disconnected.destroy();await aborted;expect(abortedCharged).toBe(0);expect(disconnected.eventNames()).toEqual([]);
});
