// SPDX-License-Identifier: AGPL-3.0-only
// The reads the settings pages draw from, made as Settings opens and kept in
// the settings store: the host's setup (which keys it holds and the agents
// here), the Ghostty file's size, the account, the devices and the image. One
// reader, so two pages asking for one record at one mount cannot ask the host
// twice, and the sidebar's search reads the same answers. An opening inside
// SETTINGS_HOLD_MS of the last asks nothing. The one door that moves the page
// rather than reading anything lands here too, since this is what the page
// mounts once.
import { useCallback, useEffect } from "react";
import { desktopBridge } from "../lib/desktopShell.js";
import { notRead } from "../notices/store.js";
import { failureOf } from "../protocol/failure.js";
import { heldFresh, hold } from "../protocol/held.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { appScheme } from "../terminal/ghosttyConfig.js";
import { useSettingsAt } from "./settingsContext.js";
import { groupOf, useSettingsStore } from "./settingsStore.js";
import { openAdd } from "./add/addFlow.js";

/** How long a read made as Settings opens stands: what these say moves on the person's own acts here, which write
 * their answers back, or on an event the page follows. */
export const SETTINGS_HOLD_MS = 60_000;

/** One of the page's reads, or nothing while the last one is in flight or inside the hold: its answer is in the store
 * already, or lands there, and an act since may have written a newer one. Nothing where the client has no such read.
 * The answers are written whether or not the page still stands, since the store outlives it. */
const held = <T>(key: string, read: (() => Promise<T>) | undefined, force = false): Promise<T> | undefined =>
  read === undefined || (!force && heldFresh(`settings:${key}`, SETTINGS_HOLD_MS)) ? undefined : hold(`settings:${key}`, read, { holdMs: SETTINGS_HOLD_MS, force });

export function useSettingsReads(): void {
  const api = useStore(s => s.api);
  const addComputerOpen = useStore(s => s.addComputerOpen);
  const devicesAsked = useSettingsStore(s => s.devicesAsked);
  const setReads = useSettingsStore(s => s.setReads);
  const onAbout = groupOf(useSettingsAt()) === "general";

  // Add a computer stands over the Computers page wherever it was asked from, so closing it shows the new row.
  useEffect(() => {
    if (!addComputerOpen) return;
    useSettingsStore.getState().go({ kind: "group", group: "computers" });
    useStore.getState().closeAddComputer();
    openAdd();
  }, [addComputerOpen]);

  useEffect(() => {
    void held("setup", api?.initGet)?.then(
      setup => setReads({ setup }),
      e => {
        setReads({ setup: null });
        notRead("Setup")(e);
      },
    );
    const scheme = appScheme();
    const terminalConfig = api?.hostTerminalConfig;
    void held(`file:${scheme}`, terminalConfig === undefined ? undefined : () => terminalConfig(scheme))?.then(
      file => setReads({ file }),
      notRead("Terminal config"),
    );
    // A refusal leaves the row without a picker rather than saying none is installed.
    void held("editors", api?.editorList)?.then(
      editors => setReads({ editors }),
      notRead("Editors"),
    );
    // The desktop shell answers for its own computer's service alone; a tab, or a window on a host elsewhere, has none.
    void desktopBridge()
      ?.loginStart?.()
      .then(
        loginStart => setReads({ loginStart }),
        notRead("Start at login"),
      );
    const readSsh = api?.sshInclude;
    void held("sshInclude", readSsh === undefined ? undefined : () => readSsh())?.then(
      sshInclude => setReads({ sshInclude }),
      notRead("ssh config"),
    );
    void held("account", api?.account)?.then(
      account => setReads({ account }),
      e => {
        setReads({ account: null });
        notRead("Account")(e);
      },
    );
  }, [api, setReads]);

  useEffect(() => {
    void held(`devices:${devicesAsked}`, api?.devicesList)?.then(
      devices => setReads({ devices, devicesRefused: false }),
      // A page served on a ticket socket is refused the list and says so in its place; anything else is a notice.
      e => {
        setReads({ devices: null, devicesRefused: failureOf(e).kind === "ticket" });
        notRead("Devices")(e);
      },
    );
  }, [api, devicesAsked, setReads]);

  // Each opening of About asks the host to read the newest release again; the host's floor keeps that to one ask.
  useEffect(() => {
    if (onAbout) void api?.releaseCheck?.().then(release => useStore.setState({ release }), notRead("Newest release"));
  }, [api, onAbout]);

  const readImage = useCallback(
    (force = false): void => {
      const image = api?.image;
      void held("image", image === undefined ? undefined : () => image(), force)?.then(
        view => setReads({ image: view }),
        notRead("Image"),
      );
    },
    [api, setReads],
  );
  // Read when the page opens, and again on every sealed frame below, since a seal anywhere files a copy the page has
  // not read.
  useEffect(() => {
    readImage();
  }, [readImage]);
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "golden.stage" && e.stage === "sealed") readImage(true);
      },
      [readImage],
    ),
  );
}
