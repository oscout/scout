import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { HostedChatJoin } from "../../../client/hosted-chat/HostedChatJoin.tsx";
import { HOSTED_CHAT_CAPABILITIES, createHostedChatApi } from "../../../client/hosted-chat/hosted-chat-api.ts";
import { InviteSheet } from "../../../client/screens/chat-space/InviteSheet.tsx";
import { ChatTransportProvider } from "../../../client/screens/chat-space/chat-transport.tsx";
import { createQueryChatAddress } from "../../../client/screens/chat-space/chat-address.ts";
import { ChatSpaceTheme, useScoutStandaloneTheme } from "../../../client/screens/chat-space/ChatSpaceTheme.tsx";
import "../../../client/styles/tokens.css";
import "../../../client/styles/primitives.css";
import "../../../client/arc-tailwind.css";
import "../../../client/app.css";

let signedIn = false;
let failJoin = false;
let joined = false;
let unavailable = false;
let kind = "teammate";
const token = `hi_${"a".repeat(32)}_${"b".repeat(64)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input, init) => {
  const path = String(input);
  if (path === "/api/auth/session") return json(signedIn ? { authenticated: true, account: { id: "alex", displayName: "Alex Rivera" }, csrfToken: "fixture-csrf" } : { authenticated: false });
  if (path.includes("/invites?") && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return json({ token, inviteUrl: `${location.origin}/${body.kind === "teammate" ? "join" : "invite"}/${token}`,
      expiresAt: Date.now() + 86400000, maxRedemptions: 1, conversationId: "general", kind: body.kind });
  }
  if (path.endsWith("/preview")) return unavailable ? json({ error: "invitation_unavailable" }, 410) : json({
    kind, channelId: "general", channelTitle: "general", space: { id: "a".repeat(32), title: "Product studio" },
    expiresAt: Date.now() + 86400000, alreadyMember: joined && signedIn,
  });
  if (path.endsWith("/join")) {
    if (!signedIn) return json({ error: "sign_in_required" }, 401);
    if (new Headers(init?.headers).get("x-csrf-token") !== "fixture-csrf") return json({ error: "csrf_denied" }, 403);
    joined = true;
    if (failJoin) { failJoin = false; throw new TypeError("Simulated lost join response"); }
    return json({ ok: true, actorId: "alex", displayName: "Alex Rivera", conversationId: "general",
      channelTitle: "general", alreadyMember: true, space: { id: "a".repeat(32), slug: "home", title: "Product studio" } });
  }
  return json({ error: "not_found" }, 404);
};
const api = createHostedChatApi();
function Fixture() {
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  return <>
    <div style={{ position: "fixed", bottom: 0, zIndex: 10, display: "flex", flexWrap: "wrap", gap: 4 }}>
      <button data-fixture="sign-in" onClick={() => { signedIn = !signedIn; refresh(); }}>Toggle fixture sign-in</button>
      <button data-fixture="lose-response" onClick={() => { failJoin = true; }}>Lose next join response</button>
      <button data-fixture="reopen" onClick={refresh}>Reopen invitation</button>
      <button data-fixture="unavailable" onClick={() => { unavailable = !unavailable; refresh(); }}>Toggle unavailable</button>
      <button data-fixture="kind" onClick={() => { kind = kind === "api" ? "teammate" : "api"; refresh(); }}>Toggle agent link</button>
    </div>
    <HostedChatJoin key={revision} token={token} api={api} />
  </>;
}
function Issuer() {
  const theme = useScoutStandaloneTheme();
  return <ChatSpaceTheme theme={theme} className="chat-space">
    <ChatTransportProvider api={api} capabilities={HOSTED_CHAT_CAPABILITIES} address={createQueryChatAddress("home")}>
      <InviteSheet channel={{ id: "general", title: "general", kind: "channel", visibility: "private", shareMode: "local", authorityNodeId: "fixture", participantIds: [] }}
        space={"a".repeat(32)} viewerActorId="alex" viewerName="Alex Rivera" onClose={() => location.assign("/join.html")} onInvitesChanged={() => {}} />
    </ChatTransportProvider>
  </ChatSpaceTheme>;
}
const issuer = new URLSearchParams(location.search).has("issuer");
if (issuer) signedIn = true;
createRoot(document.getElementById("root")!).render(<StrictMode>{issuer ? <Issuer /> : <Fixture />}</StrictMode>);
