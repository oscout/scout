import {expect,test} from 'bun:test';
import {captureRegistries} from './broker-registry-capture.js';
import {createRuntimeRegistrySnapshot} from './registry.js';

test('selected capture never traverses historical maps and retains membership across an await',async()=>{
 const agent={id:'a',displayName:'old'} as any;
 const source=createRuntimeRegistrySnapshot({agents:{a:agent}});
 source.messages=new Proxy({}, {ownKeys(){throw Error('historical messages traversed');}});
 const captured=captureRegistries({peek:()=>source,snapshot:()=>{throw Error('full snapshot');}},['agents']);
 expect(Object.keys(captured)).toEqual(['agents']);expect(captured.agents.a).toBe(agent);
 await Promise.resolve();source.agents.a={...agent,displayName:'new'};source.agents.b={...agent,id:'b'};
 expect(captured.agents.a.displayName).toBe('old');expect(captured.agents.b).toBeUndefined();
 delete captured.agents.a;expect(source.agents.a.displayName).toBe('new');
});

test('snapshot-only runtimes retain compatibility and selected maps are independent',()=>{
 const source=createRuntimeRegistrySnapshot();let calls=0;
 const captured=captureRegistries({snapshot:()=>{calls++;return source;}},['nodes','endpoints']);
 expect(calls).toBe(1);expect(Object.keys(captured)).toEqual(['nodes','endpoints']);expect(captured.nodes).not.toBe(source.nodes);
});
