import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "example",
  setup() {
    console.log("[example] plugin loaded");

    // Return cleanup for owned timers, subscriptions, and processes.
    return () => {
      console.log("[example] plugin cleaned up");
    };
  },
});
