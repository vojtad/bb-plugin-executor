import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { APPROVAL_RENDERER_ID } from "./contract.js";
import { ApprovalPrompt } from "./src/ui/approval-prompt.js";
import { ExecutorPanel } from "./src/ui/executor-panel.js";

export default definePluginApp((app) => {
  // `subPath` carries the OAuth redirect, which lands on `<panel>/oauth/callback`.
  app.slots.navPanel({
    id: "executor",
    title: "Executor",
    icon: "PlugSocket",
    path: "executor",
    component: ExecutorPanel,
  });
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalPrompt });
});
