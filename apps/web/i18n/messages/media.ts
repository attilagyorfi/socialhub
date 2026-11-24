const en = {
  "error.size": "Choose a file between 1 byte and 20 MB.",
  "error.type": "Upload a PNG, JPEG, WebP image or an MP4/MOV video.",
  "error.storage": "The private storage upload failed.",
  "error.processing": "The file could not be processed.",
  "error.upload": "Upload failed",
  upload: "Upload",
  uploading: "Uploading…",
  preview: "Media preview",
  "order.title": "Order of attachments",
  "order.hint": "They are published in this order.",
  "order.up": "Move {name} up",
  "order.down": "Move {name} down",
} as const;

const hu = {
  "error.size": "Válassz 1 bájt és 20 MB közötti fájlt.",
  "error.type": "PNG, JPEG, WebP képet vagy MP4/MOV videót tölts fel.",
  "error.storage": "Nem sikerült a feltöltés a privát tárhelyre.",
  "error.processing": "A fájlt nem sikerült feldolgozni.",
  "error.upload": "Sikertelen feltöltés",
  upload: "Feltöltés",
  uploading: "Feltöltés…",
  preview: "Média előnézet",
  "order.title": "A csatolmányok sorrendje",
  "order.hint": "Ebben a sorrendben jelennek meg a posztban.",
  "order.up": "{name} feljebb mozgatása",
  "order.down": "{name} lejjebb mozgatása",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
