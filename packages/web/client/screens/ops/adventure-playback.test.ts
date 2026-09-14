import { expect, test } from "bun:test";
import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventurePlayback } from "./adventure-playback.ts";
const stop = (arg:string, extra:Partial<AdventureStop['event']>={}) => ({id:'s',at:0,kind:'tool',label:'Tool shed',artifact:arg,event:{id:'e',at:0,t:0,kind:'tool',tool:'exec_command',text:'',arg,...extra}}) as AdventureStop;
test('read and search operations are quick hops',()=>{
 expect(adventurePlayback(stop('rg -n test src'))).toMatchObject({routine:true,checkpoint:false,durationMs:1800});
 expect(adventurePlayback({...stop('file.ts'),kind:'read'}).routine).toBe(true);
});
test('structured validation calls create checkpoints without claiming success',()=>{
 for(const command of ['bun run --cwd packages/web check','npm --prefix packages/web run test:unit','pytest tests','go test ./...','python3 -m unittest','tsc --noEmit']) {
  expect(adventurePlayback(stop(JSON.stringify({cmd:command})))).toMatchObject({checkpoint:true,routine:false,label:'Validation checkpoint'});
 }
 expect(adventurePlayback(stop('bun test',{result:{exit_code:0}})).label).toBe('Validation checkpoint');
});
test('quoted prose and test filenames are not validation evidence',()=>{
 for(const command of ['echo "bun test"','cat test.py','rg "npm test" .','node test-fixture.js']) expect(adventurePlayback(stop(command)).checkpoint).toBe(false);
 expect(adventurePlayback(stop('',{tool:'message',text:'all tests passed'})).checkpoint).toBe(false);
});
test('explicit failure overrides quick read and prose never invents failure',()=>{
 expect(adventurePlayback(stop('rg missing src',{result:{exit_code:1}}))).toMatchObject({checkpoint:true,routine:false,label:'Exit code 1'});
 expect(adventurePlayback(stop('cat failure.txt',{text:'test failed'})).routine).toBe(true);
});

test('static exec wrappers expose commands without evaluating code',()=>{
 for(const wrapper of ['text(await tools.exec_command({cmd:"bun run --cwd packages/web check",yield_time_ms:1000}));', 'await tools.exec_command({"workdir":"/project",command:"npm test"})']) {
  expect(adventurePlayback(stop(wrapper,{tool:'bash'})).checkpoint).toBe(true);
 }
 expect(adventurePlayback(stop('text(await tools.exec_command({cmd:"rg -n label src"}));')).durationMs).toBe(1800);
 for(const wrapper of ['echo \"text(await tools.exec_command({cmd:\\"bun test\\"}))\"', 'text(await tools.exec_command({cmd:"bun test" + suffix}));', 'text(await tools.exec_command({cmd:"bun test",cmd:"echo skipped"}));', 'text(await tools.exec_command({cmd:`bun test ${suite}`}));']) {
  expect(adventurePlayback(stop(wrapper)).checkpoint).toBe(false);
 }
});

test('text tool wrappers expose only recognized static calls',()=>{
 expect(adventurePlayback(stop('await tools.exec_command({cmd:"bun run --cwd packages/web check"})',{tool:'text'})).checkpoint).toBe(true);
 expect(adventurePlayback(stop('await tools.exec_command({cmd:"rg -n label src"})',{tool:'text'})).routine).toBe(true);
 expect(adventurePlayback(stop('bun test',{tool:'text'})).checkpoint).toBe(false);
 expect(adventurePlayback(stop('{"cmd":"bun test"}',{tool:'text'})).checkpoint).toBe(false);
});

test('full raw detail restores truncated summaries and multiple top-level calls',()=>{
 const detail='text(await tools.exec_command({cmd:"bun run --cwd packages/web check",yield_time_ms:1000}));\ntext(await tools.browser_open({url:"http://localhost"}));';
 expect(adventurePlayback(stop('await tools.exec_command({cmd:"bun run…',{tool:'text',detail})).checkpoint).toBe(true);
 expect(adventurePlayback(stop('text(await tools.exec_command({cmd:"echo hi"}));',{tool:'text'})).checkpoint).toBe(false);
});

test("explicit tool duration gives bounded proportional dwell", () => {
 expect(adventurePlayback(stop("build", {result:{duration_ms:10000}})).durationMs).toBe(2700);
 expect(adventurePlayback(stop("build", {result:{wall_time_seconds:100}})).durationMs).toBe(6000);
 expect(adventurePlayback(stop("build", {result:{duration_ms:-1}})).durationMs).toBe(1800);
});
