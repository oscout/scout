import { test, expect, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Execute the real route source with ONLY I/O import specifiers replaced. This
// avoids module-mock pollution of other Bun suites and forbids live broker I/O.
const temporary = mkdtempSync(join(tmpdir(), "inbox-route-test-"));
const sourceUrl = new URL("./chat.ts", import.meta.url);
const ioUrl = new URL("./test-fixtures/inbox-io.ts", import.meta.url).pathname;
const source = readFileSync(sourceUrl, "utf8").replace(/from "([^"\n]+)"/g, (_all, specifier: string) => {
  if (!specifier.startsWith(".") && !specifier.startsWith("@") && !specifier.startsWith("node:")) return _all;
  if (["core/broker/service.ts", "core/conversations/service.ts", "db-queries.ts", "web-flights.ts", "db/inbox-revision.ts"].some(suffix => specifier.endsWith(suffix))) return `from "${ioUrl}"`;
  return `from "${specifier.startsWith(".") ? new URL(specifier, sourceUrl).pathname : import.meta.resolve(specifier)}"`;
});
writeFileSync(join(temporary, "chat.ts"), source);
const { mountChatRoutes } = await import(join(temporary, "chat.ts"));
const priorFetch = globalThis.fetch;
const priorJetstream = process.env.OPENSCOUT_JETSTREAM_ENABLED;
afterAll(() => { globalThis.fetch = priorFetch; if (priorJetstream === undefined) delete process.env.OPENSCOUT_JETSTREAM_ENABLED; else process.env.OPENSCOUT_JETSTREAM_ENABLED = priorJetstream; rmSync(temporary, {recursive:true,force:true}); });
import { state } from './test-fixtures/inbox-io.ts';
import { createChannelMemberSessionAuthority, CHANNEL_MEMBER_SESSION_TTL_MS, channelMemberMayAccess } from '../core/conversations/channel-member-session.ts';
import { installScoutApiMiddleware } from '../server-core.ts';
import { ChatPresence } from '../../shared/chat-presence.ts';
import { stableChannelId } from '@openscout/protocol';
process.env.OPENSCOUT_JETSTREAM_ENABLED='false';
globalThis.fetch = async () => { throw new Error('network forbidden in review'); };
function setup(ttl=60000) {
 const id=stableChannelId('review');
 state.rows=[];state.reactions=[];state.flights=[];
 state.broker={baseUrl:'http://fixture.invalid',snapshot:{conversations:{[id]:{id,kind:'channel',participantIds:['guest','other','operator']}},actors:{},flights:{},collaborationRecords:{}}};
 const authority=createChannelMemberSessionAuthority({signingSecret:'fixture'});
 const issued=authority.mint({actorId:'guest',displayName:'Guest',channelId:id,participation:'api',nowMs:Date.now()-CHANNEL_MEMBER_SESSION_TTL_MS+ttl});
 const read=(req:Request)=>authority.validate(req.headers.get('authorization')?.slice(7));
 const app=new Hono();
 installScoutApiMiddleware(app,'review',{authToken:'operator-secret', memberAccess:(request,method,path)=>channelMemberMayAccess({grant:read(request),method,path})});
 mountChatRoutes(app,{options:{},readChannelMemberGrant:read,channelMemberSessions:authority,chatPresence:new ChatPresence(),currentDirectory:'/tmp/participant-adversarial',chatSendLimiter:{} as any});
 const request=(extra='')=>app.request(`http://localhost/api/channels/${id}/inbox?wait=3${extra}`,{headers:{authorization:`Bearer ${issued.token}`}});
 const post=(target:string)=>state.rows.push({id:crypto.randomUUID(),conversationId:id,actorId:'other',body:`private for ${target}`,createdAt:Date.now(),mentions:[{actorId:target}]});
 return {id,authority,issued,request,post,app};
}
test('credential expiry during hold fails closed, never inheriting operator',async()=>{
 const f=setup(150); const response=await f.request(); expect(response.status).toBe(200);
 await Bun.sleep(180); expect(f.authority.validate(f.issued.token)).toBeNull();
 f.post('operator');
 await expect(response.json()).rejects.toThrow();
});
test('credential revocation during hold fails closed',async()=>{
 const f=setup(); const response=await f.request(); f.authority.revoke(f.issued.token); f.post('operator');
 await expect(response.json()).rejects.toThrow();
});
test('roster removal with still-valid credential fails closed',async()=>{
 const f=setup();const response=await f.request();state.broker.snapshot.conversations[f.id].participantIds=['operator'];f.post('guest');
 await expect(response.json()).rejects.toThrow();
});
test('active lease invalidates edited message content across watchdog checks',async()=>{
 const f=setup();f.post('guest');
 const initial:any=await (await f.request()).json();
 const held=await f.request('&cursor='+encodeURIComponent(initial.nextCursor));
 state.rows[0]={...state.rows[0],body:'corrected body'};
 await Bun.sleep(1100);
 const cached:any=await (await f.request()).json();expect(cached.messages[0].body).toBe('corrected body');
 await held.body!.cancel();
 const fresh:any=await (await f.request()).json();expect(fresh.messages[0].body).toBe('corrected body');
});
test('new thread after lease wakes correctly',async()=>{
 const f=setup(); const held=await f.request();
 state.broker.snapshot.conversations['thread-new']={id:'thread-new',kind:'thread',parentConversationId:f.id,messageId:'root'};
 state.rows.push({id:'reply',conversationId:'thread-new',actorId:'other',body:'new thread',createdAt:Date.now(),mentions:[{actorId:'guest'}]});
 const data:any=await held.json();expect(data.messages[0].id).toBe('reply');
});
test('other channel denied by real middleware',async()=>{
 const f=setup();const other=stableChannelId('other');
 // fixture app is private; use unrelated token on route by granting other channel instead.
 const outsider=f.authority.mint({actorId:'other',displayName:'Other',channelId:other,participation:'api'});
 const original=f.issued.token;f.issued.token=outsider.token;
 expect((await f.request()).status).toBe(401);f.issued.token=original;
});
test('shared projection reactions and question actions are viewer-specific',async()=>{
 const f=setup();f.post('guest');state.rows[0].mentions.push({actorId:'other'});state.rows[0].actorId='author';
 const mid=state.rows[0].id;
 state.reactions=[{messageId:mid,actorId:'guest',emoji:'👍',createdAt:1}];
 state.flights=[{id:'flight',conversationId:f.id,messageId:mid,agentId:'guest',collaborationRecordId:'question'}];
 state.broker.snapshot.collaborationRecords.question={id:'question',kind:'question',conversationId:f.id,state:'open',ownerId:'guest',nextMoveOwnerId:'guest',title:'Q'};
 // Lease from another viewer with no concerning messages pins the shared cache.
 const idle=await f.app.request(`http://localhost/api/channels/${f.id}/inbox?wait=3`,{headers:{authorization:'Bearer operator-secret'}});
 const a:any=await (await f.request()).json();
 const btoken=f.authority.mint({actorId:'other',displayName:'Other',channelId:f.id,participation:'api'}).token;
 const b:any=await (await f.app.request(`http://localhost/api/channels/${f.id}/inbox`,{headers:{authorization:`Bearer ${btoken}`}})).json();
 expect(a.messages[0].reactions[0].me).toBe(true);expect(b.messages[0].reactions[0].me).toBe(false);
 expect(a.requests[0].responsibility.actions).toEqual(['answer']);expect(b.requests).toEqual([]);
 await idle.body!.cancel();state.flights=[];
});

test('guest roster exposes only active identity fields', async () => {
 const f=setup();
 const response=await f.app.request(`http://localhost/api/channels/${f.id}/members`,{headers:{authorization:`Bearer ${f.issued.token}`}});
 expect(response.status).toBe(200);
 const data:any=await response.json();
 expect(data.members.length).toBeGreaterThan(0);
 for(const member of data.members) expect(Object.keys(member).sort()).toEqual(['actorId','displayName','kind']);
});

test('active lease refreshes a reaction when the database revision moves', async () => {
 const f=setup(); f.post('guest');
 const initial:any=await (await f.request()).json();
 const held=await f.request('&cursor='+encodeURIComponent(initial.nextCursor));
 state.reactions=[{messageId:state.rows[0].id,actorId:'guest',emoji:'👍',createdAt:Date.now()}];
 state.revision=(state.revision ?? 1)+1;
 await Bun.sleep(1100);
 try {
  const fresh:any=await (await f.request()).json();
  expect(fresh.messages[0].reactions[0].me).toBe(true);
 } finally { await held.body!.cancel(); state.revision=1; }
});

test('active lease refreshes flight/collaboration state from the snapshot with no revision change', async () => {
 const f=setup(); f.post('guest');
 const initial:any=await (await f.request()).json();
 const held=await f.request('&cursor='+encodeURIComponent(initial.nextCursor));
 state.flights=[{id:'flight',conversationId:f.id,messageId:state.rows[0].id,agentId:'guest',state:'completed',collaborationRecordId:'question'}];
 state.broker.snapshot.collaborationRecords.question={id:'question',kind:'question',conversationId:f.id,state:'open',ownerId:'guest',nextMoveOwnerId:'guest',title:'Q',updatedAt:Date.now()};
 await Bun.sleep(1100);
 try {
  const fresh:any=await (await f.request()).json();
  expect(fresh.requests[0].state).toBe('completed');
  expect(fresh.requests[0].responsibility.actions).toEqual(['answer']);
 } finally { await held.body!.cancel(); }
});
