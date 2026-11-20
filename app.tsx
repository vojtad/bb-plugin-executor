import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { APPROVAL_RENDERER_ID } from "./contract.js";
import { ApprovalPrompt } from "./src/ui/approval-prompt.js";
import { EXECUTOR_LOGO_URI } from "./src/ui/executor-logo.js";
import { ExecutorPanel } from "./src/ui/executor-panel.js";

const ICON = "executor/logo";

export default definePluginApp((app) => {
  app.experimental_icons.register({
    name: ICON,
    component: ({ className }) => <img src={EXECUTOR_LOGO_URI} alt="" className={className} />,
  });
  // `subPath` carries the OAuth redirect, which lands on `<panel>/oauth/callback`.
  app.slots.navPanel({
    id: "executor",
    title: "Executor",
    icon: ICON,
    path: "executor",
    component: ExecutorPanel,
  });
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalPrompt });
});
