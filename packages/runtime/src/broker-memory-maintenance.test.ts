import { BrokerDurableStore } from "./broker-durable-store.js";
import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrokerMemoryMaintenance,memoryMaintenanceFromEnv} from './broker-memory-maintenance.js';
import {FileBackedBrokerJournal,type BrokerJournalEntry} from './broker-journal.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const message=(id:string,body='text'):BrokerJournalEntry=>({kind:'message.record',message:{id,body,actorId:'operator',originNodeId:'node',conversationId:'conversation',class:'agent',visibility:'private',policy:'durable',createdAt:1700000000000}});

test('independent replay passes account bytes, finish once, and record collection cost',()=>{
 let clock=0,calls=0;const m=new BrokerMemoryMaintenance({replayWorkBytes:10,collect:()=>{calls++;clock+=3;},now:()=>clock});
 const a=m.beginReplay(),b=m.beginReplay();a.add(9);b.add(9);expect(calls).toBe(0);a.add(1);expect(calls).toBe(1);
 a.finish();a.add(100);a.finish();expect(calls).toBe(1);b.finish();b.finish();expect(calls).toBe(2);
 expect(m.status()).toMatchObject({collections:2,replayCollections:2,totalMs:6,maxMs:3});
});

test('accepted fanout and encoded byte budgets trigger independently without idle timers',()=>{
 let calls=0;const m=new BrokerMemoryMaintenance({liveWorkRecords:4,liveWorkBytes:100,collect:()=>{calls++;}});
 m.accepted([{kind:'deliveries.record',deliveries:new Array(3).fill({})} as BrokerJournalEntry],1);expect(calls).toBe(0);
 m.accepted([message('x')],1);expect(calls).toBe(1);
 m.accepted([message('huge')],100);expect(calls).toBe(2);
 m.accepted([],0);expect(calls).toBe(2);
});

test('disabled and unsupported collectors are explicit, and invalid configuration is rejected',()=>{
 expect(memoryMaintenanceFromEnv({})).toBeUndefined();
 const m=new BrokerMemoryMaintenance({replayWorkBytes:1,liveWorkRecords:1});m.beginReplay().add(1);m.accepted([message('x')],1);
 expect(m.status()).toMatchObject({enabled:true,available:false,collections:0,failure:null});
 for(const liveWorkBytes of [0,-1,NaN,Infinity])expect(()=>new BrokerMemoryMaintenance({liveWorkBytes})).toThrow();
});

test('collector exceptions cannot reject accepted messages or poison subsequent control writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scout-maintenance-'));roots.push(root);let calls=0;
 const m=new BrokerMemoryMaintenance({liveWorkRecords:1,collect:()=>{calls++;throw Error('collector unavailable');}});
 const journal=new FileBackedBrokerJournal(join(root,'journal.jsonl'),{memoryMaintenance:m});await journal.load();
 try{
  await journal.appendEntries(message('one'));await journal.appendEntries(message('two'));
  await journal.appendEntries({kind:'node.upsert',node:{id:'node',meshId:'mesh',name:'Node',advertiseScope:'local',registeredAt:1}});
  await journal.appendEntries({kind:'flight.record',flight:{id:'completed-flight',invocationId:'invocation',requesterId:'operator',targetAgentId:'agent',state:'completed',completedAt:1700000001000}});
  expect(journal.snapshot().flights['completed-flight'].state).toBe('completed');
  expect(journal.snapshot().messages.one.body).toBe('text');expect(journal.snapshot().messages.two.body).toBe('text');expect(journal.snapshot().nodes.node.name).toBe('Node');
  expect(calls).toBe(1);expect(m.status()).toMatchObject({available:false,failure:'collector unavailable'});
 }finally{journal.close();}
});

test('journal charges exact encoded UTF-8 bytes for large Unicode payloads and skips deduped work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scout-maintenance-'));roots.push(root);let calls=0;
 const entry=message('large','😀é\ud800'.repeat(200000));const bytes=Buffer.byteLength(JSON.stringify(entry)+'\n');
 const m=new BrokerMemoryMaintenance({liveWorkRecords:100000,liveWorkBytes:bytes,collect:()=>{calls++;}});
 const journal=new FileBackedBrokerJournal(join(root,'journal.jsonl'),{memoryMaintenance:m});await journal.load();
 try{await journal.appendEntries(entry);expect(calls).toBe(1);expect((await readFile(join(root,'journal.jsonl'))).length).toBe(bytes);
 const node:BrokerJournalEntry={kind:'node.upsert',node:{id:'n',meshId:'m',name:'Node',advertiseScope:'local',registeredAt:1}};
 await journal.appendEntries(node);const before=calls;expect(await journal.appendEntries(node)).toEqual([]);expect(calls).toBe(before);
 }finally{journal.close();}
});

test('failed canonical append is not charged as accepted work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scout-maintenance-'));roots.push(root);const path=join(root,'journal.jsonl');let calls=0;
 const m=new BrokerMemoryMaintenance({liveWorkRecords:1,collect:()=>{calls++;}});const journal=new FileBackedBrokerJournal(path,{memoryMaintenance:m});await journal.load();await mkdir(path);
 try{await expect(journal.appendEntries(message('rejected'))).rejects.toThrow();expect(calls).toBe(0);expect(journal.snapshot().messages.rejected).toBeUndefined();}finally{journal.close();}
});

test('replay maintenance covers invalid lines without converting them into accepted records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scout-maintenance-'));roots.push(root);const path=join(root,'journal.jsonl');await writeFile(path,'bad json\n\n'+JSON.stringify(message('kept'))+'\n');let calls=0;
 const m=new BrokerMemoryMaintenance({replayWorkBytes:1,collect:()=>{calls++;}});const journal=new FileBackedBrokerJournal(path,{memoryMaintenance:m});
 try{const report=await journal.load();expect(report.invalidLines).toBe(1);expect(report.validEntries).toBe(1);expect(calls).toBeGreaterThanOrEqual(3);expect(journal.snapshot().messages.kept.body).toBe('text');}finally{journal.close();}
});


test('large accepted-byte accounting reaches delayed projection after work and publication finish',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let published=false;const observations:boolean[]=[];
 const m=new BrokerMemoryMaintenance({liveWorkRecords:10000,liveWorkBytes:100,collect:()=>{observations.push(published);}});
 const store=new BrokerDurableStore({memoryMaintenance:m,journal:{appendEntries:async entries=>{m.accepted(entries,100);return entries;}},projection:{applyEntries:async()=>{await gate;return [{}] as any;}},threadEvents:{publish:()=>{published=true;}}});
 await store.commitEntries([message('delayed')],async()=>{});
 expect(m.status()).toMatchObject({liveCollections:1,projectionCollections:0});
 release();await store.flushProjectedEntries();
 expect(m.status()).toMatchObject({liveCollections:1,projectionCollections:1});expect(observations).toEqual([false,true]);
});

test('snapshot output shares a byte budget without retaining per-reader state',()=>{
 let calls=0;const m=new BrokerMemoryMaintenance({replayWorkBytes:10,collect:()=>{calls++;}});
 m.snapshotEncoded(6);m.snapshotEncoded(4);expect(calls).toBe(1);
 m.snapshotEncoded(NaN);m.snapshotEncoded(-1);m.snapshotEncoded(0);expect(calls).toBe(1);
 m.snapshotEncoded(9);expect(calls).toBe(1);m.snapshotEncoded(1);expect(calls).toBe(2);
 expect(m.status()).toMatchObject({snapshotCollections:2,replayCollections:0,liveCollections:0,projectionCollections:0});
 const failed=new BrokerMemoryMaintenance({replayWorkBytes:1,collect:()=>{throw new Error('collector failed');}});
 expect(()=>failed.snapshotEncoded(2)).not.toThrow();expect(failed.status().available).toBe(false);
});
