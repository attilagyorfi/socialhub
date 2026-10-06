const en = {
  "error.size": "Choose a file between 1 byte and 20 MB.",
  "error.type": "Upload a PNG, JPEG, WebP image or MP4 video.",
  "error.storage": "The private storage upload failed.",
  "error.processing": "The file could not be processed.",
  "error.upload": "Upload failed",
  upload: "Upload",
  uploading: "Uploading…",
  preview: "Media preview",
} as const;

const hu = {
  "error.size": "Válassz 1 bájt és 20 MB közötti fájlt.",
  "error.type": "PNG, JPEG, WebP képet vagy MP4 videót tölts fel.",
  "error.storage": "Nem sikerült a feltöltés a privát tárhelyre.",
  "error.processing": "A fájlt nem sikerült feldolgozni.",
  "error.upload": "Sikertelen feltöltés",
  upload: "Feltöltés",
  uploading: "Feltöltés…",
  preview: "Média előnézet",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
