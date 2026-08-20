import type { NavigateOptions } from "../../lib/router.ts";
import type { Route } from "../../lib/types.ts";

type OpenContentOptions = {
  /** Where the back affordance on the target content view should return. */
  returnTo?: Route;
};

/**
 * Navigate to a content/detail route while recording a back destination
 * for that route's BackToPicker via history entry state.
 * If `returnTo` is omitted, no back state is set (the target screen's fallback applies).
 */
export function openContent(
  navigate: (route: Route, options?: NavigateOptions) => void,
  target: Route,
  options: OpenContentOptions = {},
): void {
  if (options.returnTo) {
    navigate(target, { returnTo: options.returnTo });
    return;
  }
  navigate(target);
}
