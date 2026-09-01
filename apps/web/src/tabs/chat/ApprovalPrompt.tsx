// SPDX-License-Identifier: AGPL-3.0-only
// KNOWN PROTOCOL GAP (wsp-map #22): the wire has no approval/question event
// type; v1 adapters run sandboxed permission mode and never ask. These types
// are a local fixture contract, exercised only from tests, so the UI is ready
// when @wsp/protocol grows the event alongside the permission-mode adapter
// change. Do not import protocol types here until that lands.
import styles from "./ChatTab.module.css";

export interface ApprovalRequest {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail?: string;
  /** First option is the confirming one; it gets the spend/confirm accent. */
  options: [string, ...string[]];
}

export function ApprovalPrompt({ request, onRespond }: {
  request: ApprovalRequest;
  onRespond: (id: string, choice: string) => void;
}) {
  return (
    <div className={styles.approval} role="group" aria-label={request.title}>
      <div className={styles.approvalTitle}>{request.title}</div>
      {request.detail ? <div className={styles.approvalDetail}>{request.detail}</div> : null}
      <div className={styles.approvalKeys}>
        {request.options.map((opt, i) => (
          <button
            key={opt}
            type="button"
            className={i === 0 ? `${styles.key} ${styles.confirm}` : styles.key}
            onClick={() => onRespond(request.id, opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
