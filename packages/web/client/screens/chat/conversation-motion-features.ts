import { domAnimation } from "motion/react";

// Loaded only after the thread shell and composer have rendered. The skeleton
// is useful without JavaScript motion; this bundle adds the small orbit/pulse
// flourish without putting Motion's DOM animation features on first paint.
export default domAnimation;
