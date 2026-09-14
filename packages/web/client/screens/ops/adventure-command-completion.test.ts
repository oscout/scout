import { expect, test } from "bun:test";
import { observeDataFromTail } from "./agent-lanes-model.ts";
import type { TailEvent, TailDiscoveredTranscript } from "../../lib/types.ts";
const at=1_800_000_000_000;
const transcript={source:'codex',sessionId:'session',mtimeMs:at} as TailDiscoveredTranscript;
function event(payload:unknown):TailEvent{return {id:'done',ts:at,source:'codex',sessionId:'session',kind:'system',summary:'item_completed',raw:{type:'event_msg',payload}} as TailEvent;}
test('explicit command completion preserves exit and command without marking task complete',()=>{
 const data=observeDataFromTail(transcript,[event({type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc','bun test'],exit_code:0,status:'completed'}})],false,{now:at});
 expect(data.events[0]).toMatchObject({kind:'tool',tool:'exec_command',arg:'bun test',result:{exit_code:0},text:'Command completed'});
});
test('prose claiming completion never establishes a process exit',()=>{
 const data=observeDataFromTail(transcript,[event({type:'item_completed',item:{type:'AgentMessage',text:'bun test exited 0'}})],false,{now:at});
 expect(data.events[0].result).toBeUndefined();
 expect(data.events[0].kind).not.toBe('tool');
});
