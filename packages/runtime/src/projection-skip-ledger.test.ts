import { expect, test } from 'bun:test';
import { ProjectionSkipLedger } from './projection-skip-ledger';
test('skip diagnostics stay bounded under distinct malformed kinds and long reasons', () => {
 const ledger=new ProjectionSkipLedger();
 for(let i=0;i<10000;i++) ledger.record(`bad-kind-${i}`,`reason-${i}-`+'x'.repeat(1000));
 ledger.record('message.record',new Error('constraint'));
 const s=ledger.snapshot();expect(s.total).toBe(10001);expect(Object.keys(s.byKind)).toEqual(['unknown','message.record']);
 expect(s.byKind.unknown.count).toBe(10000);expect(s.byKind.unknown.firstReason.startsWith('reason-0-')).toBe(true);
 expect(s.byKind.unknown.lastReason.startsWith('reason-9999-')).toBe(true);expect(s.byKind.unknown.lastReason.length).toBe(256);
 s.byKind.unknown.count=0;expect(ledger.snapshot().byKind.unknown.count).toBe(10000);
 expect(new ProjectionSkipLedger().snapshot().total).toBe(0);
});
