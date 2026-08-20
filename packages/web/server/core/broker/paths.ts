// Paths for the local broker HTTP API. The canonical map lives in
// @openscout/protocol (broker-routes.ts); this file is a thin re-export so
// existing imports keep working.

export {
  scoutBrokerPaths,
  scoutBrokerMessagesListPath,
  scoutBrokerMessagesPath,
  scoutBrokerInvocationPath,
  scoutBrokerInvocationStreamPath,
  scoutBrokerInvocationLifecyclePath,
} from "@openscout/protocol";

export const openAiAudioSpeechUrl = "https://api.openai.com/v1/audio/speech" as const;
