// Adapted from pingdotgg/t3code apps/web/src/components/chat/ExpandedImagePreview.tsx at 57a66608 (MIT).
export interface ExpandedImageItem {
  src: string;
  name: string;
  type?: "video";
  autoPlay?: boolean;
  /** Authored remote destination to open when embedding fails, never a generated asset URL. */
  originalUrl?: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}
