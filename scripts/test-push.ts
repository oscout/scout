#!/usr/bin/env bun
// One-shot APNs broadcast for testing. Reads creds from env (use `secret run`):
//   secret run OPENSCOUT_APNS_TEAM_ID OPENSCOUT_APNS_KEY_ID OPENSCOUT_APNS_PRIVATE_KEY_BASE64 \
//     -- bun scripts/test-push.ts "Title" "Body"

import { broadcastApnsAlertToActiveMobileDevices } from "@openscout/runtime/mobile-push";

const title = process.argv[2] ?? "Ping";
const body = process.argv[3] ?? "You asked me to. Now you have notifications.";

const result = await broadcastApnsAlertToActiveMobileDevices({
  title,
  body,
  sound: "default",
  threadId: "scout.inbox",
  payload: {
    destination: "inbox",
    source: "test-push",
  },
});

console.log(JSON.stringify(result, null, 2));
if (result.failedCount > 0 || result.configMissing) {
  process.exit(1);
}
