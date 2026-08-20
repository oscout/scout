import {
  forwardScoutbotUiActionToNativeHost,
  type ScoutbotUiAction,
} from "../lib/scoutbot.ts";
import type { Route } from "../lib/types.ts";

type NativeUiActionForwarder = (action: ScoutbotUiAction) => boolean;

/**
 * A native embed owns only its document; the host owns product navigation.
 * Keeping this boundary here prevents every embeddable screen from having to
 * remember whether its `navigate` callback is allowed to replace the WebView.
 */
export function routeEmbeddedNavigation(
  route: Route,
  navigate: (route: Route) => void,
  forwardToNative: NativeUiActionForwarder = forwardScoutbotUiActionToNativeHost,
  /**
   * Routes that stay on the embedded surface. The host has no better answer
   * for these than "you are already there", so handing them over would drop
   * the state change on the floor.
   */
  isInternalRoute: (route: Route) => boolean = () => false,
): void {
  if (!isInternalRoute(route) && forwardToNative({ type: "navigate", route })) return;
  navigate(route);
}
