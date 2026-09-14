/** A persisted Scout message and its explicit audience, never inferred from prose. */
export type WorldBrokerMessage = { id: string; from: string[]; to: string[]; at: number; body: string };
type Snapshot = {
  messages: Record<string, { id:string; actorId:string; createdAt:number; body:string; class:string; metadata?:Record<string,unknown>; audience?:{notify?:string[];invoke?:string[];delivery?:string} }>;
  endpoints: Record<string, {agentId:string;sessionId?:string;metadata?:Record<string,unknown>}>;
};
export function worldBrokerMessages(snapshot: Snapshot, now: number): WorldBrokerMessage[] {
  const identities = (id:string) => {
    const sessions = [...new Set(Object.values(snapshot.endpoints).filter(e=>e.agentId===id && e.sessionId).map(e=> { const native = e.metadata?.externalSessionId ?? e.metadata?.threadId ?? e.metadata?.nativeSessionId; return typeof native === "string" && native.trim() ? native.trim() : e.sessionId!; }))];
    // A long-lived agent with multiple sessions cannot identify a single actor.
    return sessions.length === 1 ? [id, sessions[0]] : [id];
  };
  return Object.values(snapshot.messages).filter(m=>m.class==='agent' && m.createdAt<=now && now-m.createdAt<900000 && m.audience?.delivery!=='none')
    .sort((a,b)=>b.createdAt-a.createdAt).slice(0,200).flatMap(m=>
      [...new Set([...(m.audience?.notify??[]),...(m.audience?.invoke??[]),...(Array.isArray(m.metadata?.relayTargetIds) ? m.metadata.relayTargetIds.filter((id): id is string => typeof id === "string") : [])])].filter(to=>to!==m.actorId).map(to=>({id:`broker:${m.id}:${to}`,from:identities(m.actorId),to:identities(to),at:m.createdAt,body:m.body})));
}
