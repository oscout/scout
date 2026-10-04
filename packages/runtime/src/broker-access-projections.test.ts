import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Readable } from "node:stream";
import { MeshAccessStore } from "./mesh-access-store.js";
import { handleBrokerAccessRoute, type BrokerAccessHttpDeps } from "./broker-access-http-routes.js";
import { signAccessArtifact, type AccessDelegation, type AccessPolicy } from "./mesh-access.js";
import { nodeKeyId } from "./node-identity.js";
import { accessTestFixture, accessTestKey } from "./test-helpers/access-fixture.test.ts";

const unsigned = <T extends {signature: string}>(value: T) => { const { signature, ...rest } = value; return rest; };
function fixture() {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true); store.importGrant(f.grant);
  store.enroll({ networkId: f.policy.networkId, agentIds: ["fabric", "secret"], projects: [] }, new Set(), new Set(["fabric", "secret"]));
  const invocations = new Map<string, any>(), messages: any[] = [];
  let probes = 0;
  const deps: BrokerAccessHttpDeps = { access: store, nodeId: "receiver", nodeKeyId: f.audience,
    listAgents: () => [{id:"fabric",displayName:"Fabric"},{id:"secret",displayName:"Secret"}], enforced: () => true,
    ingressPosture: async () => { probes++; throw new Error("remote status must never probe"); },
    ensureGuestActor: async () => {}, openThread: async ({requesterId,targetAgentId}) => ({id:`dm.${requesterId}.${targetAgentId}`,kind:"direct",title:"work",visibility:"private",shareMode:"local",authorityNodeId:"receiver",participantIds:[requesterId,targetAgentId]}),
    postMessage: async (message) => { messages.push(message); }, invoke: async (request) => { invocations.set(request.id, request); return {accepted:true}; },
    existingInvocation: (id) => invocations.get(id), flightForInvocation: (id) => invocations.has(id) ? {id:`flight-${id}`,invocationId:id,requesterId:invocations.get(id).requesterId,targetAgentId:invocations.get(id).targetAgentId,state:"running",summary:"Working"} : undefined };
  const certificate = (key=f.admin, actions: any[]=["admin","discover","read-own","request"], all=true) => signAccessArtifact<AccessDelegation>(key, {...unsigned(f.delegation),id:`device-${crypto.randomUUID()}`,principalId:nodeKeyId(key.publicKey),devicePublicKey:accessTestKey().publicKey,scope:{all,agentIds:all?[]:["fabric"],projectIds:[]},actions});
  async function call(body: any, delegation=f.delegation) {
    const proof = store.verifyDelegation(delegation); store.acceptDelegation(delegation);
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {method:"POST",url:"/v1/access/rpc",headers:{"content-type":"application/json"},transportContext:{transport:"remote",scoped:proof}});
    const response: any = {status:0,body:"",writeHead(status:number){this.status=status;return this;},end(chunk:string){this.body+=chunk??"";},setHeader(){}};
    await handleBrokerAccessRoute(request as any,response,new URL("http://test/v1/access/rpc"),"POST",deps);
    return {status:response.status,json:JSON.parse(response.body)};
  }
  return {...f,store,db,call,certificate,messages,invocations,probes:()=>probes};
}
test("status filters members at the canonical broker and never probes posture", async () => {
  const f=fixture(); try {
    const admin=f.certificate(); await f.call({operation:"network.status"},admin);
    const result=await f.call({operation:"network.status"});
    expect(result.status).toBe(200); expect(result.json.canAdmin).toBe(false);
    expect(result.json.principals.map((p:any)=>p.principal.id)).toEqual([f.subject.id]);
    expect(result.json.resources.agents.map((a:any)=>a.id)).toEqual(["fabric"]);
    expect(result.json.grants.every((g:any)=>g.subjectId===f.subject.id)).toBe(true);
    expect(result.json.delegations.every((d:any)=>d.principalId===f.subject.id)).toBe(true);
    expect(result.json.devices.every((d:any)=>d.principalId===f.subject.id)).toBe(true);
    expect(result.json.policy).toBeUndefined(); expect(JSON.stringify(result.json)).not.toContain('"secret"');
    expect(f.probes()).toBe(0);
    expect((await f.call({operation:"network.status",principalId:f.adminPrincipal.id})).status).toBe(400);
    expect((await f.call({operation:"access.preview",artifact:admin})).status).toBe(403);
  } finally {f.db.close();}
});
test("administrative projection needs current role, admin action AND all-resource delegation", async()=>{
  const f=fixture();try{
    const admin=f.certificate();
    expect((await f.call({operation:"network.status"},admin)).json.canAdmin).toBe(true);
    for(const d of [f.certificate(f.admin,["discover"]),f.certificate(f.admin,["admin","discover"],false)]){
      const result=await f.call({operation:"network.status"},d);expect(result.json.canAdmin).toBe(false);expect(result.json.principals).toHaveLength(1);expect(result.json.policy).toBeUndefined();
    }
    f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner,{...unsigned(f.policy),revision:2,members:f.policy.members.map(m=>m.principal.id===f.adminPrincipal.id?{...m,role:"member" as const}:m)}),false);
    const result=await f.call({operation:"network.status"},admin);expect(result.json.canAdmin).toBe(false);expect(result.json.principals).toHaveLength(1);expect(result.json.resources.agents).toEqual([]);
  }finally{f.db.close();}
});
test("own-work projection and result IDs cannot cross principals or survive revoked read access",async()=>{
  const f=fixture();try{
    const admin=f.certificate();
    const own=await f.call({operation:"request",requestId:"work-0001",target:"fabric",body:"my task"});
    const foreign=await f.call({operation:"request",requestId:"work-0002",target:"fabric",body:"other task"},admin);
    expect(own.status).toBe(202);expect(foreign.status).toBe(202);
    const list=await f.call({operation:"work.list"});expect(list.json.work.map((w:any)=>w.id)).toEqual([own.json.invocationId]);
    expect(JSON.stringify(list.json)).not.toContain("flight-");expect((await f.call({operation:"result",workId:foreign.json.invocationId})).status).toBe(404);
    expect((await f.call({operation:"result",workId:own.json.invocationId})).status).toBe(200);
    f.store.revoke(f.policy.networkId,"grant",`${f.grant.issuerId}:${f.grant.id}`);
    expect((await f.call({operation:"work.list"})).json.work).toEqual([]);expect((await f.call({operation:"result",workId:own.json.invocationId})).status).toBe(404);
  }finally{f.db.close();}
});
test("device approval is same-principal public certificate only; preview uses exact evaluator",async()=>{
  const f=fixture();try{
    const admin=f.certificate();
    expect((await f.call({operation:"device.approve",artifact:admin})).status).toBe(403);
    const device=accessTestKey(), delegation=signAccessArtifact<AccessDelegation>(f.service,{...unsigned(f.delegation),id:"new-device",devicePublicKey:device.publicKey});
    expect((await f.call({operation:"device.approve",artifact:delegation})).json.possessionProven).toBe(false);expect(f.store.knownDevice(nodeKeyId(device.publicKey))).toBe(false);
    const preview=await f.call({operation:"access.preview",artifact:delegation},admin);expect(preview.json.agents.map((a:any)=>a.id)).toEqual(["fabric"]);
    f.store.revoke(f.policy.networkId,"delegation",`${f.subject.id}:new-device`);
    expect((await f.call({operation:"access.preview",artifact:delegation},admin)).status).toBe(403);
  }finally{f.db.close();}
});
test("remote projections read bounded pages and never use the all-network operator status",async()=>{
  const f=fixture();try{
    for(let i=0;i<105;i++) f.store.importDelegation(signAccessArtifact<AccessDelegation>(f.service,{...unsigned(f.delegation),id:`paged-${String(i).padStart(3,"0")}`,devicePublicKey:accessTestKey().publicKey}));
    f.store.status=()=>{throw new Error("ambient status must not be used");};
    const first=await f.call({operation:"network.status"});expect(first.json.delegations).toHaveLength(100);expect(first.json.pagination.nextOffset).toBe(100);
    const second=await f.call({operation:"network.status",offset:100});expect(second.json.delegations).toHaveLength(6);expect(second.json.pagination.nextOffset).toBeNull();
    expect(new Set([...first.json.delegations,...second.json.delegations].map((d:any)=>d.id)).size).toBe(106);
    for(const offset of [-1,1.2,1000001,"0"])expect((await f.call({operation:"network.status",offset})).status).toBe(400);
  }finally{f.db.close();}
});
