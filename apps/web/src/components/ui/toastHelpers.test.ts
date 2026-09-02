// Adapted from pingdotgg/t3code apps/web/src/components/ui/toastHelpers.test.ts at 57a66608 (MIT).
import { assert, describe, it } from "vitest";

import { hiddenToastActionProps, stackedThreadToast } from "./toastHelpers";

describe("hiddenToastActionProps", () => {
  it("is a defined update payload so Base UI can replace a previous action", () => {
    assert.equal(hiddenToastActionProps.children, null);
    assert.equal(
      "actionProps" in stackedThreadToast({ type: "loading", title: "Updating" }),
      false,
    );
    assert.deepEqual(
      stackedThreadToast({
        type: "loading",
        title: "Updating",
        actionProps: hiddenToastActionProps,
      }).actionProps,
      hiddenToastActionProps,
    );
  });
});
