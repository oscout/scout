// Reuse the web area rather than maintaining a second native implementation.
import { nativeOpsOwnsInternalRoute } from "../../surfaces/embed-navigation.ts";
import { useOptionalFlag } from "hudsonkit/flags";
import { OpsScreen } from "./OpsScreen.tsx";
import { useScout } from "../../scout/Provider.tsx";
import { defineSurface, type EmbedScreenProps } from "../../surfaces/types.ts";


export function NativeAreaScreen({ navigate }: EmbedScreenProps) {
  const { route } = useScout();
  const opsControlEnabled = useOptionalFlag("ops.control", true);
  return <OpsScreen navigate={navigate}
    mode={(route.view === "ops" ? route.mode : undefined) ?? (opsControlEnabled ? "mission" : "tail")}
    tailQuery={route.view === "ops" ? route.tailQuery : undefined}
    showSecondaryNav />;

}

export const scoutSurface = defineSurface({
  id: "ops",
  label: "Ops",
  route: { view: "ops" },
  webPath: "/ops",
  screen: "NativeAreaScreen",
  embed: {
    path: "/embed/ops",
    profile: "macos.ops",
    ownsInternalRoutes: true,
    // These modes already have dedicated native seats. Hand them back instead
    // of mounting a second Tail, Lanes or Agents document inside Ops.
    isInternalRoute: nativeOpsOwnsInternalRoute,
    hosts: { macos: true },
  },
});
