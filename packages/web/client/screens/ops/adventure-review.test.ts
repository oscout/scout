import { expect, test } from "bun:test";
import { adventureReviewReason } from "./adventure-review.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";
const stop = (extra = {}): AdventureStop => ({id:"test",at:1,kind:"tool",label:"Tool",artifact:"",event:{id:"test",t:1,kind:"tool",tool:"bash",text:"all tests passed",arg:"bun test",...extra}});
test("default review waits for observed result, not a test invocation or success prose",()=>{
 expect(adventureReviewReason(stop(),"results")).toBeNull();
 expect(adventureReviewReason(stop({result:{exit_code:0}}),"results")).toBe("Validation result ready");
 expect(adventureReviewReason(stop({arg:"cat app.ts",result:{exit_code:0}}),"results")).toBeNull();
});
test("problems catches explicit failures while continuous never stops",()=>{
 expect(adventureReviewReason(stop({result:{exit_code:1}}),"problems")).toContain("attention");
 expect(adventureReviewReason(stop({result:{exit_code:0}}),"problems")).toBeNull();
 expect(adventureReviewReason(stop({result:{exit_code:1}}),"continuous")).toBeNull();
 expect(adventureReviewReason(stop(),"all")).not.toBeNull();
});
