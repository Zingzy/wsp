// SPDX-License-Identifier: AGPL-3.0-only
// A project's glyph and hue as two selects on its settings page, each drawn with
// what it picks, saved on the pick and drawn at once wherever the project shows;
// the glyph's select ends in the road to an image of the person's own.
import { ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ProjectHue, ProjectIcon } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectSeparator, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { cn } from "../lib/utils.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "./look.js";
import { PROJECTS_WORDS } from "../settings/format.js";
import { SELECT_WIDTH } from "../settings/layout.js";

const word = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

function IconOption({ icon, hue }: { icon: ProjectIcon; hue: ProjectHue }) {
  const Glyph = PROJECT_GLYPHS[icon];
  return (
    <span className="flex items-center gap-2">
      <Glyph aria-hidden className={cn("size-4", PROJECT_HUES[hue].text)} />
      {word(icon)}
    </span>
  );
}

function HueOption({ hue }: { hue: ProjectHue }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("size-3 rounded-full", PROJECT_HUES[hue].swatch)} />
      {word(hue)}
    </span>
  );
}

/** The value the select holds while the project wears an image, and the foot item that opens the file chooser. */
const IMAGE = "image";
const CHOOSE = "choose";

/** A project's glyph, and where `onChooseImage` is given the image it wears: `image` is that image drawn at 16 px, set
 * while one is worn. Picking a glyph means wanting the glyph, so the caller clears the image on `onChange`. A recipe's
 * own glyph takes no image, so it passes neither. */
export function IconSelect({ icon, hue, image, onChange, onChooseImage, className }: { icon: ProjectIcon; hue: ProjectHue; image?: ReactNode; onChange: (icon: ProjectIcon) => void; onChooseImage?: () => void; className?: string }) {
  return (
    <Select
      value={image === undefined ? icon : IMAGE}
      onValueChange={next => {
        if (next === CHOOSE) onChooseImage?.();
        else if (next !== IMAGE) onChange(ProjectIcon.parse(next));
      }}
    >
      <SelectTrigger size="sm" aria-label="Icon" data-k="project-icon" className={cn(SELECT_WIDTH, className)}>
        <SelectValue>
          {(value: string) =>
            value === IMAGE ? (
              <span className="flex items-center gap-2">
                {image}
                {PROJECTS_WORDS.iconImage}
              </span>
            ) : (
              <IconOption icon={ProjectIcon.parse(value)} hue={hue} />
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ProjectIcon.options.map(name => (
          <SelectItem key={name} value={name}>
            <IconOption icon={name} hue={hue} />
          </SelectItem>
        ))}
        {onChooseImage === undefined ? null : (
          <>
            <SelectSeparator />
            <SelectItem value={CHOOSE} data-k="project-icon-choose">
              <span className="flex items-center gap-2">
                <ImageIcon aria-hidden className="size-4" />
                {image === undefined ? PROJECTS_WORDS.chooseImage : PROJECTS_WORDS.chooseAnother}
              </span>
            </SelectItem>
          </>
        )}
      </SelectPopup>
    </Select>
  );
}

export function HueSelect({ hue, onChange, className }: { hue: ProjectHue; onChange: (hue: ProjectHue) => void; className?: string }) {
  return (
    <Select value={hue} onValueChange={next => onChange(ProjectHue.parse(next))}>
      <SelectTrigger size="sm" aria-label="Colour" data-k="project-hue" className={cn(SELECT_WIDTH, className)}>
        <SelectValue>{(value: ProjectHue) => <HueOption hue={value} />}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ProjectHue.options.map(name => (
          <SelectItem key={name} value={name}>
            <HueOption hue={name} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
