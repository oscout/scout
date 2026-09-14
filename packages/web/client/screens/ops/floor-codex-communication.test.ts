import { expect, test } from "bun:test";
import type { TailEvent } from "../../lib/types.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import { floorCodexCommunication } from "./floor-codex-communication.ts";
import { floorExchanges } from "./floor-exchanges.ts";
const now = 1_800_000_000_000;
const envelope = (author:string,recipient:string,content:unknown[]) => ({ source:"codex", raw:{type:"response_item",payload:{type:"agent_message",author,recipient,content}} }) as TailEvent;
test("received envelopes resolve task handles to actual sessions in both directions",()=>{
  const header=(from:string,to:string) => `Message Type: MESSAGE\nTask name: ${to}\nSender: ${from}\nPayload:\n`;
  const receivedA=floorCodexCommunication(envelope('/root/worker','/root',[{type:'input_text',text:header('/root/worker','/root')+'Ready for review'}]));
  const receivedB=floorCodexCommunication(envelope('/root','/root/worker',[{type:'input_text',text:header('/root','/root/worker')},{type:'encrypted_content',encrypted_content:'opaque'}]));
  const lanes=[{id:'a',agent:{id:'a',name:'Codex'},observe:{events:[{id:'one',at:now-2,t:0,...receivedA}]}},{id:'b',agent:{id:'b',name:'Huygens'},observe:{events:[{id:'two',at:now-1,t:0,...receivedB}]}}] as unknown as AgentLane[];
  const exchange=floorExchanges(lanes,now)[0];
  expect(exchange.messages.map(m=>[m.from,m.to,m.text])).toEqual([['b','a','Ready for review'],['a','b','Message contents unavailable']]);
  const ambiguous=[...lanes,{...lanes[0],id:'other',agent:{...lanes[0].agent,id:'other',name:'Other'}}];
  expect(floorExchanges(ambiguous,now)).toEqual([]);
});
test("ignores prose-only and metadata-only events",()=>{
  expect(floorCodexCommunication({source:'codex',raw:{type:'inter_agent_communication_metadata',payload:{trigger_turn:true}}} as TailEvent)).toBeNull();
  expect(floorCodexCommunication({source:'codex',raw:{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Sender: /root'}]}}} as TailEvent)).toBeNull();
});
