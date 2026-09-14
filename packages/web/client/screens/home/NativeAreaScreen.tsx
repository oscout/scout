// Reuse the web area rather than maintaining a second native implementation.
import { HomeContent } from "./content.tsx";
import { defineSurface, type EmbedScreenProps } from "../../surfaces/types.ts";


export function NativeAreaScreen({ navigate }: EmbedScreenProps) {
  return <HomeContent navigate={navigate} />;
}

export const scoutSurface = defineSurface({
  id: "home",
  label: "Home",
  route: { view: "inbox" },
  webPath: "/",
  screen: "NativeAreaScreen",
  embed: {
    path: "/embed/home",
    profile: "macos.home",
    ownsInternalRoutes: true,
    hosts: { macos: true },
  },
});
