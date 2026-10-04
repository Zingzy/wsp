// SPDX-License-Identifier: AGPL-3.0-only
// The three slates of the owner's 2026-10-03 sessions (gold and traffic, the networking quiz, the Zoho inbox) as the
// kit writes them, with the values their screenshots show, so the renderer's tests draw what the person saw.
import { parseSlate, slateStartValues, type SlateDoc, type SlateJson } from "@wsp/protocol";

export const GOLD_TEXT = `<slate title="Gold and traffic">
  <run name="spot" cmd="curl -s https://api.gold-api.com/price/XAU" every={60} />
  <run name="retail" cmd="python3 retail.py" every={1800} />
  <run name="cf" cmd="python3 cloudflare.py" every={60} />
  <column>
    <section title="Gold" note="checked 23s">
      <number label="Spot, per troy ounce" value={$spot.json.usd} format="usd" note="opens Mon 3:30 AM IST" />
      <status>{$spot.json.market}</status>
    </section>
    <section title="Bengaluru retail, per gram" note="checked 24s">
      <table items={$retail.json.rates} key={item.karat}><col title="" value={item.karat} /><col title="" value={item.gram} /></table>
    </section>
    <section title="Cloudflare requests" note="checked 22s">
      <chart label="spoo.me, requests a minute, last hour" items={$cf.json.minutes} x={item.at} value={item.n} format="integer" />
      <text size="small">Ends two minutes back, since Cloudflare fills the newest minutes late.</text>
      <table items={$cf.json.zones} key={item.zone}>
        <col title="Zone" value={item.zone} />
        <col title="Last hour" value={item.hour} />
        <col title="Latest minute" value={item.minute} />
      </table>
    </section>
  </column>
</slate>`;

/** Requests a minute over the hour, read off the screenshot, ending on the latest minute the zone table shows. */
const RPM = [1000, 560, 880, 600, 760, 500, 1300, 1150, 1310, 890, 1210, 820, 1100, 1350, 700, 920, 960, 820, 640, 1100, 1200, 1250, 900, 820, 600, 720, 1560, 1550, 800, 1210, 860, 1120, 660, 1400, 1000, 1750, 850, 1100, 1500, 1200, 1950, 900, 860, 740, 650, 1120, 800, 1000, 1230, 1000, 1224];
const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const done = (json: SlateJson): SlateJson => ({ state: "done", exit: 0, json, runs: 3 });

export const GOLD_VALUES: Record<string, SlateJson> = {
  spot: done({ usd: 4141.8, market: "Closed" }),
  retail: done({ rates: [{ karat: "24K", gram: "₹14,918" }, { karat: "22K", gram: "₹13,675" }, { karat: "18K", gram: "₹11,189" }] }),
  cf: done({
    minutes: RPM.map((n, i) => ({ at: clock(21 * 60 + 48 + Math.round((i * 59) / (RPM.length - 1))), n })),
    zones: [
      { zone: "spoo.me", hour: "59,961", minute: "1,224" },
      { zone: "wakeupba.be", hour: "83", minute: "2" },
      { zone: "pickuptheph.one", hour: "7", minute: "0" },
      { zone: "singhi.me", hour: "0", minute: "0" },
    ],
  }),
};

export const QUIZ_TEXT = `<slate title="Networking quiz">
  <value name="round" start="2" />
  <value name="pick" start={2} />
  <column>
    <row><button label="Round 1: basics" variant="quiet" onPress={set($round, "1")} /><button label="Round 2: harder" variant="quiet" onPress={set($round, "2")} /></row>
    <section title="Question 15 of 15" note="6 of 15 right">
      <choices label="A router connects two switches, and each switch has 5 PCs. How many broadcast domains are there?" value={$pick} options={[1, 4, 2, 10]} answer={2} />
      <text>Right. Each router interface is a separate broadcast domain, so 2. (Each switch port is its own collision domain, which is a different question.)</text>
      <button label="Review my mistakes" onPress={send("Review my mistakes")} />
    </section>
    <section title="Context" note="this thread, as of the latest turn" collapsible>
      <meter label="Window used" value={185000} max={1000000} format="tokens" note="815k free of 1M" />
      <facts>
        <fact label="Input" value="5.3M" mono />
        <fact label="Cached read" value="4.93M" mono />
        <fact label="Cache write" value="373k" mono />
        <fact label="Output" value="89.4k" mono />
        <fact label="Cost" value="$4.64" mono />
      </facts>
    </section>
    <section title="Gold in Bengaluru" note="INR per gram" open={false}>
      <grid columns={3}>
        <number label="24K" value="₹14,918" />
        <number label="22K" value="₹13,675" />
        <number label="18K" value="₹11,189" />
      </grid>
    </section>
  </column>
</slate>`;

export const INBOX_TEXT = `<slate title="Zoho mail">
  <value name="box" start="aditya@singhi.me" />
  <value name="unread" start={false} />
  <run name="mail" cmd="python3 zoho_mail.py" env={{ BOX: $box }} every={60} />
  <column>
    <row>
      <select label="Mailbox" value={$box} options={["aditya@singhi.me", "admin@spoo.me"]} />
      <toggle label="Unread" value={$unread} />
    </row>
    <section title="Inbox" note="checked 4s">
      <table items={$mail.json} key={item.when}>
        <col title="When" value={item.when} mono />
        <col title="From" value={item.from} />
        <col title="Subject" value={item.subject} />
        <col title="Unread" value={item.unread} />
        <action label="Open" onPress={send("Open this message", item.when, item.from)} />
      </table>
    </section>
  </column>
</slate>`;

export const INBOX_VALUES: Record<string, SlateJson> = {
  mail: done([
    ["2026-10-03 22:21", "PostHog", "Here's a 'dangerously-skip-permissions' macro pad", "unread"],
    ["2026-10-03 14:22", "google-noreply@google.com", "Reminder about Google's Terms of Service", "unread"],
    ["2026-09-29 18:45", "noreply@sender.zohocalendar.in", "Reminder: Aditya<>Sujay @ Tue Sep 29, 2026 07:00 pm - 07:30 pm (Asia/Kolkata)", ""],
    ["2026-09-29 13:35", "sujay@lab0.ai", "Invitation: Aditya<>Sujay @ Tue 29 Sept 2026 7pm - 7:30pm (IST) (aditya@singhi.me)", ""],
    ["2026-09-29 12:00", "messages@binary.so", "RE: Update on your application - Join Supermemory founding team - Engineering and research", ""],
    ["2026-09-29 11:55", "messages@binary.so", "RE: Update on your application - Join Supermemory founding team - Engineering and research", ""],
    ["2026-09-29 09:45", "noreply@sender.zohocalendar.in", "Reminder: Chat with Aditya Singhi @ Tue Sep 29, 2026 10:00 am - 10:15 am (Asia/Kolkata)", ""],
    ["2026-09-29 09:00", "hello@cal.com", "Reminder: Chat with Aditya Singhi - Tue, Sep 29, 2026 10:00am", ""],
  ].map(([when, from, subject, unread]) => ({ when, from, subject, unread }) as SlateJson)),
};

/** One of the three, parsed by the protocol's own parser, with its values over the document's start values. */
export function todaySlate(text: string, values: Record<string, SlateJson> = {}): { doc: SlateDoc; values: Record<string, SlateJson> } {
  const parsed = parseSlate(text);
  if (parsed.document === undefined) throw new Error(parsed.errors.map(e => e.message).join("\n"));
  return { doc: parsed.document, values: { ...slateStartValues(parsed.document), ...values } };
}
