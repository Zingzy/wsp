// Adapted from pingdotgg/t3code apps/web/src/components/chat/FileTagChip.tsx at 57a66608 (MIT).
// Differs from upstream: the kind is read off the path here, since wsp's
// PierreEntryIcon draws lucide's file and folder marks and takes no theme work.
import { COMPOSER_INLINE_CHIP_CLASS_NAME, COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME } from "../composerInlineChip";
import { PierreEntryIcon } from "./PierreEntryIcon";

export const FILE_TAG_CHIP_CLASS_NAME = COMPOSER_INLINE_CHIP_CLASS_NAME;

export function FileTagChipContent(props: { path: string; label: string; theme: "light" | "dark" }) {
  return (
    <>
      <PierreEntryIcon pathValue={props.path} kind={props.path.endsWith("/") ? "directory" : "file"} theme={props.theme} className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </>
  );
}
