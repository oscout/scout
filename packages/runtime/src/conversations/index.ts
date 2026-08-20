/**
 * SCO-031 §5: service-shaped facades over `SQLiteControlPlaneStore`.
 *
 * `Conversations` (implements `ConversationsApi`) is the home for
 * conversation identity logic — `findByNaturalKey`, `ensureByNaturalKey`,
 * `resolveLegacyId` — and lands here so SCO-030 has a single place to
 * extend. Other aggregates extract opportunistically as their domains
 * get surgery (SCO-031 §2 non-goals).
 */

export type {
  ConversationsApi,
  EnsureConversationInput,
} from "./api.js";
export { Conversations } from "./api.js";
