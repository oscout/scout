export { defineSurface, defaultEmbedPath, resolveEmbedChrome } from "./types.ts";
export type {
  EmbedScreenProps,
  RegisteredSurface,
  ScoutSurfaceDefinition,
  ScoutSurfaceEmbed,
} from "./types.ts";
export {
  listEmbeddableSurfaceSummaries,
  resolveEmbeddableSurface,
} from "./discover.ts";
export { shouldBootstrapDiscoveredEmbed } from "./embed-path.ts";
export { DiscoveredEmbedHost } from "./EmbedHost.tsx";
export { mountDiscoveredEmbed } from "./embed-entry.tsx";
