/**
 * Hosted Scout Chat — the browser entry for the Cloudflare Worker.
 *
 * It mounts the same `ChatSpaceSurface` that `/chat` mounts on a local Scout,
 * with the same stylesheet and the same interactions, and hands it a transport
 * pointed at the Worker instead of the local server. There is no second copy of
 * the interface here and nothing in this file draws anything.
 *
 * The operator broker shell is deliberately absent — as it is for local
 * `/chat` — so none of the local broker surface is reachable from this page.
 * `/admin` is a separate hosted-only operations screen, not that shell.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ChatSpaceSurface } from "../screens/chat-space/ChatSpaceSurface.tsx";
import { ChatTransportProvider } from "../screens/chat-space/chat-transport.tsx";
import { createPathChatAddress } from "../screens/chat-space/chat-address.ts";
import {
  applyScoutThemeToDocument,
  resolveScoutStartupAppearanceDetails,
  resolveScoutStartupTemplate,
  resolveScoutStartupTheme,
} from "../lib/theme.ts";

import { HostedChatJoin } from "./HostedChatJoin.tsx";
import { HostedChatSetup } from "./HostedChatSetup.tsx";
import { signInOptionsFor } from "./HostedDoor.tsx";
import { HostedChatAdmin } from "./HostedChatAdmin.tsx";
import { HostedChatLanding } from "./HostedChatLanding.tsx";
import { createHostedChatApi, HOSTED_CHAT_CAPABILITIES, HOSTED_SIGN_IN_PROVIDERS, HOSTED_SIGNED_OUT_MESSAGE, hostedSignInNote } from "./hosted-chat-api.ts";
import { claimFromSearch } from "./hosted-chat-claim.ts";
import { authErrorFromSearch } from "./hosted-chat-auth-error.ts";
import { HostedClaimNotice } from "./HostedClaimNotice.tsx";
import { ChatApiError } from "../screens/chat-space/chat-api.ts";

import "../styles/tokens.css";
import "../styles/primitives.css";
import "../arc-tailwind.css";
import "../app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

applyScoutThemeToDocument(
  resolveScoutStartupTheme(),
  resolveScoutStartupTemplate(),
  resolveScoutStartupAppearanceDetails(),
);

const { returnToParam } = HOSTED_CHAT_CAPABILITIES.signIn;
// GitHub is the pilot's standing provider: a document without the Worker's
// provider list (local dev with no credentials, an older Worker) still draws
// the door rather than degrading to a bare button.
const providers = HOSTED_SIGN_IN_PROVIDERS.length
  ? HOSTED_SIGN_IN_PROVIDERS
  : [{ id: "github", label: "GitHub", startPath: HOSTED_CHAT_CAPABILITIES.signIn.startPath }];
const signInOptions = signInOptionsFor(providers, returnToParam);

if (window.location.pathname === "/admin") {
  createRoot(root).render(
    <StrictMode>
      <HostedChatAdmin />
    </StrictMode>,
  );
} else if (/^\/join\/hi_[a-f0-9]{32}_[a-f0-9]{64}$/.test(window.location.pathname)) {
  const api = createHostedChatApi();
  createRoot(root).render(<StrictMode><HostedChatJoin token={window.location.pathname.slice("/join/".length)} api={api} signInOptions={signInOptions} /></StrictMode>);
} else {
  // Built once, outside render: the transport is identity for the surface, and a
  // new object every render would restart every poll.
  const api = createHostedChatApi();
  // Hosted spaces live at `/<slug>`; the Worker serves this page for both `/`
  // and that path, so the address grammar is the only thing that has to know.
  const address = createPathChatAddress("");
  // A sign-in the Worker refused sends the browser back here with its reason,
  // rather than serving the visitor a page of JSON (`auth.ts`, `doorFor`).
  const authError = authErrorFromSearch(window.location.search);
  // What sign-in hands over, for the providers this deployment actually has —
  // never a sentence about GitHub on a door that only offers X.
  const signInNote = hostedSignInNote(providers);

  const mount = (notice: string | null) => {
    createRoot(root).render(
      <StrictMode>
        <ChatTransportProvider
          api={api}
          capabilities={HOSTED_CHAT_CAPABILITIES}
          address={address}
        >
          {/* Hosted Chat has its own door: the address-first entrance rather than
              the shared gate card. Local `/chat` mounts the surface with no
              `signedOut` and keeps the card it has always had. */}
          <ChatSpaceSurface
            signedOut={(view) => (
              <HostedChatLanding
                {...view}
                message={view.message === HOSTED_SIGNED_OUT_MESSAGE ? null : view.message}
                authError={authError}
                note={signInNote}
                signInOptions={signInOptions}
              />
            )}
          />
          {notice ? <HostedClaimNotice message={notice} /> : null}
        </ChatTransportProvider>
      </StrictMode>,
    );
  };

  // Back from sign-in with a name reserved on the earlier door (`?claim=`, still
  // honoured for sign-ins that began before the door stopped asking): create the
  // space at exactly that address and go there; refused, the visitor lands in
  // Chat with the reason. A refused sign-in is not an instruction to create
  // anything: there is no session.
  const claim = authError ? null : claimFromSearch(window.location.search);
  // A new account has no space yet. Rather than open the surface on an empty
  // placeholder, the root asks for the space's name first. Anything but a
  // definite "signed in, no spaces" — signed out, an error, a room's address —
  // mounts the surface, which owns every other state.
  const setup = (displayName: string | null) => {
    createRoot(root).render(
      <StrictMode>
        <HostedChatSetup
          displayName={displayName}
          createSpace={async (slug) => (await api.createSpace({ title: slug, slug })).space.slug}
          signOut={() => api.signOut()}
        />
      </StrictMode>,
    );
  };

  if (!claim) {
    if (window.location.pathname === "/" && !window.location.search && !authError) {
      Promise.all([api.spaces(), api.invitationSession()]).then(
        ([{ spaces }, session]) => (spaces.length ? mount(null) : setup(session.account?.displayName ?? null)),
        () => mount(null),
      );
    } else {
      mount(null);
    }
  } else {
    api.createSpace({ title: claim, slug: claim }).then(
      (created) => window.location.replace(`/${created.space.slug}`),
      async (error: unknown) => {
        if (error instanceof ChatApiError && error.isUnauthenticated) {
          mount(null);
          return;
        }
        const taken = error instanceof ChatApiError && error.reason === "slug_unavailable";
        if (taken) {
          // Already theirs (a second trip through the door): just open it.
          const owned = await api.spaces().then((found) => found.spaces, () => []);
          if (owned.some((space) => space.slug === claim)) {
            window.location.replace(`/${claim}`);
            return;
          }
        }
        window.history.replaceState(null, "", "/");
        mount(taken
          ? `${window.location.host}/${claim} is already taken. Create a space with another name from the space menu.`
          : error instanceof Error ? error.message : `${claim} could not be created.`);
      },
    );
  }
}
