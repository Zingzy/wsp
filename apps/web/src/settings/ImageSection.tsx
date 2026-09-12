// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Image: what this computer has sealed and where it stands. Before
// anything is sealed the row says so and one sentence says what will build it;
// after a seal the row carries the record's facts, the Built row carries when
// and from where, and a table names every computer and provider holding a copy
// with the word for whether that copy stands on the record as it is now. That
// word sits in a slot as wide as the longer of the two, so one arriving or
// leaving moves no column. Edit opens the six init screens as they ship, under
// the title Your image, so there is one set of those screens in the app and
// this section only puts a door on them.
import { useEffect, useState } from "react";
import { copyStanding, fmtBytes, type SealedImageView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { CloudSetupDialog } from "../sidebar/CloudSetupDialog.js";
import { FACT } from "./format.js";
import { builtFact, builtWhen, IMAGE_WORDS, imageFacts } from "./image.js";
import { Row, Section } from "./rows.js";

const CELL = "font-mono text-xs tabular-nums text-foreground";
const QUIET = "text-muted-foreground";
/** The standing word's slot, seven mono characters, which is what the longer of the two words takes: the columns
 * after it stand in the same place whether a copy reads current, stale or nothing at all. */
const STANDING_SLOT = "inline-block w-[7ch]";

/** One row's facts in the page's fact grammar, with the whole line on its title: a window narrow enough to cut it
 * still hands the reader every word. */
const Fact = ({ k, line }: { k: string; line: string }) => (
  <span className={FACT} data-k={k} title={line}>
    {line}
  </span>
);

export function ImageSection() {
  const api = useStore(s => s.api);
  const [view, setView] = useState<SealedImageView | null>(null);
  const [editing, setEditing] = useState(false);
  // Read again when the sheet shuts, since a build that ran behind it changes every fact on this section; while it
  // stands open there is nothing here to repaint.
  useEffect(() => {
    if (api?.image === undefined || editing) return;
    let live = true;
    void api.image().then(
      next => {
        if (live) setView(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, editing]);
  const image = view?.image ?? null;
  const edit = (
    <Button data-k="edit-image" variant="outline" size="xs" onClick={() => setEditing(true)}>
      {IMAGE_WORDS.edit}
    </Button>
  );
  return (
    <Section id="settings-image" title={IMAGE_WORDS.title}>
      {/* Until the host has answered there is no fact to say: the row stands with its label and its button, and
          `not built yet` is drawn only once the read has come back holding no record. */}
      <Row id="settings-image-row" label={IMAGE_WORDS.image} {...(view === null ? {} : { fact: <Fact k="image-facts" line={image === null ? IMAGE_WORDS.notBuilt : imageFacts(image)} /> })}>
        {edit}
      </Row>
      {image === null ? (
        <Row id="settings-image-first" label={IMAGE_WORDS.firstBuild} note />
      ) : (
        <Row id="settings-image-built" label={IMAGE_WORDS.built} fact={<Fact k="image-built" line={builtFact(image)} />} />
      )}
      {image === null || view === null || view.copies.length === 0 ? null : (
        <div data-k="image-copies" className="mt-2 overflow-hidden rounded-[10px] border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{IMAGE_WORDS.copyAt}</TableHead>
                <TableHead>{IMAGE_WORDS.version}</TableHead>
                <TableHead className="text-right">{IMAGE_WORDS.size}</TableHead>
                <TableHead>{IMAGE_WORDS.copyBuilt}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.copies.map(copy => (
                <TableRow key={copy.place} data-k="image-copy" data-place={copy.place}>
                  <TableCell className="text-xs text-foreground">{copy.place}</TableCell>
                  <TableCell className={CELL}>
                    {`v${copy.version} `}
                    <span data-k="copy-state" className={cn(STANDING_SLOT, QUIET)}>
                      {copyStanding(image, copy) ?? ""}
                    </span>
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right")} data-k="copy-size">
                    {copy.sizeBytes === undefined ? "" : fmtBytes(copy.sizeBytes)}
                  </TableCell>
                  <TableCell className={cn(CELL, QUIET)}>{builtWhen(copy.builtAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing ? <CloudSetupDialog onClose={() => setEditing(false)} /> : null}
    </Section>
  );
}
