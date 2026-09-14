import {expect,test} from 'bun:test';
import {worldBrokerMessages} from './world-broker-messages.ts';
const message = {id:'m',actorId:'a',createdAt:1000,body:'hello b',class:'agent'};
test('only explicit persisted audience creates routes, with unique session identity',()=>{
 const snapshot={messages:{m:message},endpoints:{a:{agentId:'a',sessionId:'s1'},b:{agentId:'b',sessionId:'s2'}}};
 expect(worldBrokerMessages(snapshot,1100)).toEqual([]);
 const result=worldBrokerMessages({...snapshot,messages:{m:{...message,audience:{notify:['b'],invoke:['b']}}}},1100);
 expect(result).toEqual([{id:'broker:m:b',from:['a','s1'],to:['b','s2'],at:1000,body:'hello b'}]);
 expect(worldBrokerMessages({...snapshot,messages:{m:{...message,audience:{notify:['b'],delivery:'none'}}}},1100)).toEqual([]);
});
test('ambiguous sessions do not get a guessed binding; stale messages expire',()=>{
 const snapshot={messages:{m:{...message,audience:{notify:['b']}}},endpoints:{a:{agentId:'a',sessionId:'s1'},a2:{agentId:'a',sessionId:'s3'}}};
 expect(worldBrokerMessages(snapshot,1100)[0].from).toEqual(['a']);
 expect(worldBrokerMessages(snapshot,901001)).toEqual([]);
});

test("canonical Scout relay metadata routes a persisted ask",()=>{
 expect(worldBrokerMessages({messages:{m:{...message,metadata:{relayTargetIds:["b"]}}},endpoints:{}},1100)[0].to).toEqual(["b"]);
});

test("recorded provider session links the recipient to its observed harness actor",()=>{
 expect(worldBrokerMessages({messages:{m:{...message,audience:{invoke:["b"]}}},endpoints:{b:{agentId:"b",sessionId:"route-id",metadata:{externalSessionId:"native-id"}}}},1100)[0].to).toEqual(["b","native-id"]);
});
