// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Devices: every computer and browser paired with this wsp, one
// row each with when it paired and when it was last seen, and Revoke at the
// right. A scoped record is a running thread's token, not a device a person
// revokes, so it is not a row. A page served on a ticket socket is refused
// the list and says so in one line.
import { useState } from "react";
import { offlineFor, type DeviceView } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, DANGER_BUTTON } from "../components/ui/button.js";
import { errorText } from "../lib/utils.js";
import type { Api } from "../protocol/client.js";
import { DEVICES_WORDS, WHERE_WORDS } from "./format.js";
import { builtWhen } from "./image.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

/** The devices a person revokes: every record with no scope. */
export const revocableDevices = (devices: ReadonlyArray<DeviceView>): DeviceView[] => devices.filter(device => device.scope === undefined);

/** The name a row reads: the device's own, or this browser for the one wsp init opened here. */
export const deviceName = (device: DeviceView): string => (device.here === true ? DEVICES_WORDS.thisBrowser : device.name);

export const deviceDescription = (device: DeviceView, now: number): string => DEVICES_WORDS.paired(builtWhen(device.createdAt, now), offlineFor(now - Date.parse(device.lastSeenAt)));

/** The one act on a device: asks, then takes its token away and reads the list again. */
export function RevokeControl({ device, api, onRevoked, toast }: { device: DeviceView; api: Api | null; onRevoked: () => void; toast: (line: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const revoke = (): void => {
    if (api?.devicesRevoke === undefined) return;
    setBusy(true);
    void api
      .devicesRevoke(device.id)
      .then(
        () => {
          setAsking(false);
          onRevoked();
        },
        (e: unknown) => toast(errorText(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button data-k="revoke" size="xs" variant="outline" className={DANGER_BUTTON} held={api?.devicesRevoke === undefined} onClick={() => setAsking(true)}>
        {DEVICES_WORDS.revoke}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup data-revoke-device-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle data-k="revoke-title">{DEVICES_WORDS.revokeTitle(deviceName(device))}</AlertDialogTitle>
            <AlertDialogDescription data-k="revoke-sentence">{DEVICES_WORDS.revokeDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{WHERE_WORDS.cancel}</AlertDialogClose>
            <Button data-k="revoke-confirm" variant="destructive" disabled={busy} onClick={revoke}>
              {DEVICES_WORDS.revoke}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function devicesCards(ctx: SettingsContext): SettingsCardData[] {
  const { devices, devicesRefused } = ctx.reads;
  if (devicesRefused) return [{ id: "devices", items: [{ kind: "line", id: "refused", label: DEVICES_WORDS.refused, attrs: { "data-k": "devices-refused" } }] }];
  const rows = revocableDevices(devices ?? []);
  if (devices !== null && rows.length === 0) return [{ id: "devices", items: [{ kind: "line", id: "none", label: DEVICES_WORDS.none, attrs: { "data-k": "devices-none" } }] }];
  return [
    {
      id: "devices",
      items: rows.map(device => ({
        kind: "row" as const,
        id: device.id,
        title: deviceName(device),
        description: deviceDescription(device, ctx.now),
        mono: true,
        attrs: { "data-device-row": device.id },
        control: <RevokeControl device={device} api={ctx.api} onRevoked={ctx.rereadDevices} toast={ctx.toast} />,
      })),
    },
  ];
}
