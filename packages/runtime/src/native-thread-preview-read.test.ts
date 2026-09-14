import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";
import { buildNativeReadThreadArtifact, serializeNativeReadThreadArtifact } from "./conversation-thread-artifact.js";
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function store() {
  const root=mkdtempSync(join(tmpdir(),'scout-native-preview-'));roots.push(root);
  const s=new SQLiteControlPlaneStore(join(root,'control.sqlite'));
  s.upsertNode({id:'n',meshId:'mesh',name:'Node',advertiseScope:'local',registeredAt:1});
  s.upsertActor({id:'a',kind:'person',displayName:'Actor 雪'});
  s.upsertConversation({id:'c',kind:'direct',title:'Preview',visibility:'private',shareMode:'local',authorityNodeId:'n',participantIds:['a']});
  return s;
}
const options={conversationId:'c',projectionId:'p',projectionVersion:1,sequence:7,generatedAt:1700000000000};
function add(s:SQLiteControlPlaneStore,id:string,body:string,createdAt=1700000000000) {
  s.recordMessage({id,conversationId:'c',actorId:'a',originNodeId:'n',class:'agent',body,visibility:'private',policy:'durable',createdAt});
}
function compare(s:SQLiteControlPlaneStore,limit=64) {
  const full=s.getConversationThreadLaunchSnapshot({...options,limit})!;
  const preview=s.getConversationThreadLaunchSnapshot({...options,limit,nativePreview:true})!;
  expect(serializeNativeReadThreadArtifact(buildNativeReadThreadArtifact(preview))).toBe(serializeNativeReadThreadArtifact(buildNativeReadThreadArtifact(full)));
  expect({...preview,messages:[]}).toEqual({...full,messages:[]});
  return {full,preview};
}
test('native SQL prefix preserves exact artifact bytes across escaping, Unicode, NUL and boundary sizes',()=>{
  const s=store();
  try {
    for(const pattern of ['x','雪','🚀','é','\\','"','\n','\0','\ufeff','\ud800','\udc00','a雪🚀"\\\n']) {
      for(const length of [0,1,16000,32000,32600,32767,32768,32769,32770,65536,131072]) {
        const body=pattern.repeat(Math.ceil(length/pattern.length)).slice(0,length);add(s,'m',body);
        const before=s.getConversationThreadLaunchSnapshot({...options,limit:1})!;
        const {full,preview}=compare(s,1);
        expect(full).toEqual(before);
        // Replacing a partial terminal UTF-8 sequence can add at most two bytes.
        expect(Buffer.byteLength(preview.messages[0]!.body)).toBeLessThanOrEqual(32774);
        expect(s.getConversationThreadLaunchSnapshot({...options,limit:1})).toEqual(before);
        if(!body.includes('\0') && body==='x'.repeat(length) && length>32772)expect(preview.messages[0]!.body.length).toBe(32772);
      }
    }
    for (const offset of [1, 2, 3]) {
      add(s, 'm', 'x'.repeat(offset) + '🚀'.repeat(20000));
      const { preview } = compare(s, 1);
      expect(preview.messages[0]!.body.endsWith('\ufffd')).toBe(true);
    }
  } finally{s.close();}
});
test('whole-page eviction, earlier cursor, normalization and rich actor metadata are unchanged',()=>{
  const s=store();
  try {
    s.upsertActor({id:'a',kind:'person',displayName:'雪🚀"\\'.repeat(1000)});
    for(let i=0;i<70;i++)add(s,'m-'+String(i).padStart(3,'0'),i%3===0?'large-雪🚀"\n'.repeat(24000):'small-'+i, i%2?1700000000000+i*1000:1700000000+i);
    for(const limit of [1,2,32,64]){
      const {full,preview}=compare(s,limit);
      expect(full.hasEarlier).toBe(true);
      expect(preview.messages.map(m=>m.id)).toEqual(full.messages.map(m=>m.id));
    }
    const {full,preview}=compare(s);
    const fullBytes=full.messages.reduce((n,m)=>n+Buffer.byteLength(m.body),0);
    const previewBytes=preview.messages.reduce((n,m)=>n+Buffer.byteLength(m.body),0);
    expect(previewBytes).toBeLessThan(fullBytes/3);
    expect(s.getConversationThreadLaunchSnapshot({...options,conversationId:'absent',nativePreview:true})).toBeNull();
  }finally{s.close();}
});
