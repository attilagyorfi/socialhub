// "format.*" are Luxon format strings.
const en = {
  "format.month": "MMMM yyyy",
  "format.listDate": "dd MMM · HH:mm",
  "nav.previous": "Previous period",
  "nav.next": "Next period",
  "nav.today": "Today",
  "mode.Month": "Month",
  "mode.Week": "Week",
  "mode.List": "List",
  "filter.network": "Filter network",
  "filter.allNetworks": "All networks",
  "filter.status": "Calendar status",
  "filter.allStatuses": "All statuses",
  "filter.author": "Filter author",
  "filter.allAuthors": "All authors",
  loading: "Loading…",
  count: "{count} scheduled posts",
  empty: "No scheduled posts match these filters.",
  dragHint: "Drag to another day, or open for an exact time",
  truncated:
    "This range contains more than 1,000 posts. Narrow the dates or filters to see all results.",
  help: "Calendar data is loaded independently for the visible date range. Open a scheduled post to choose an exact time.",
  "help.drag":
    "Calendar data is loaded independently for the visible date range. Open a scheduled post to choose an exact time, or drag it to another day while keeping its current time.",
  "error.load": "Unable to load calendar.",
  "error.dstMove":
    "That local time is unavailable or ambiguous in {timeZone} during a daylight-saving change. Open the post and choose an exact time.",
  "error.timeMissing":
    "That local time does not exist in {timeZone} because of a daylight-saving change.",
  "error.timeAmbiguous":
    "That local time occurs twice in {timeZone}. Choose an unambiguous time.",
} as const;

const hu = {
  "format.month": "yyyy. MMMM",
  "format.listDate": "MMM d. · HH:mm",
  "nav.previous": "Előző időszak",
  "nav.next": "Következő időszak",
  "nav.today": "Ma",
  "mode.Month": "Hónap",
  "mode.Week": "Hét",
  "mode.List": "Lista",
  "filter.network": "Szűrés hálózat szerint",
  "filter.allNetworks": "Minden hálózat",
  "filter.status": "Szűrés állapot szerint",
  "filter.allStatuses": "Minden állapot",
  "filter.author": "Szűrés szerző szerint",
  "filter.allAuthors": "Minden szerző",
  loading: "Betöltés…",
  count: "{count} ütemezett poszt",
  empty: "Nincs a szűrőknek megfelelő ütemezett poszt.",
  dragHint: "Húzd át egy másik napra, vagy nyisd meg a pontos időponthoz",
  truncated:
    "Ebben az időszakban több mint 1000 poszt van. Szűkítsd a dátumokat vagy a szűrőket, hogy mindet lásd.",
  help: "A naptár a látható időszak adatait külön tölti be. Nyiss meg egy ütemezett posztot a pontos időpont kiválasztásához.",
  "help.drag":
    "A naptár a látható időszak adatait külön tölti be. Nyiss meg egy ütemezett posztot a pontos időpont kiválasztásához, vagy húzd át egy másik napra – az időpontja megmarad.",
  "error.load": "Nem sikerült betölteni a naptárat.",
  "error.dstMove":
    "Ez a helyi időpont az óraátállítás miatt nem létezik vagy nem egyértelmű ({timeZone}). Nyisd meg a posztot, és válassz pontos időpontot.",
  "error.timeMissing":
    "Ez a helyi időpont az óraátállítás miatt nem létezik ({timeZone}).",
  "error.timeAmbiguous":
    "Ez a helyi időpont kétszer fordul elő ({timeZone}). Válassz egyértelmű időpontot.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
