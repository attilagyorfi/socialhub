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
  "import.title": "Import calendar",
  "import.subtitle":
    "Upload a month's calendar from a CSV or JSON file (up to 1 MB, {max} rows). Every post becomes a draft.",
  "import.file": "File (.csv, .json)",
  "import.sampleCsv": "Sample CSV",
  "import.sampleJson": "Sample JSON",
  "import.help":
    "The sample files already contain this client's accounts. Put the account ID in the targets column; separate several accounts with |.",
  "import.noAccounts":
    "This client has no connected account yet. Connect one first.",
  "import.checking": "Checking the file…",
  "import.ready": "All good: {count} drafts will be created.",
  "import.hasErrors": "Found {count} errors. Fix the file and upload it again.",
  "import.lineError": "Line {line}: {message}",
  "import.previewLabel": "Import preview",
  "import.col.line": "Line",
  "import.col.date": "Date",
  "import.col.channels": "Channels",
  "import.col.text": "Text",
  "import.col.result": "Result",
  "import.rowOk": "OK",
  "import.submit": "Import",
  "import.done": "{count} drafts imported.",
  "import.failed": "Couldn't process the file. Try again.",
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
  "import.title": "Naptár importálása",
  "import.subtitle":
    "Tölts fel egy havi naptárt CSV- vagy JSON-fájlból (legfeljebb 1 MB, {max} sor). Minden poszt vázlat lesz.",
  "import.file": "Fájl (.csv, .json)",
  "import.sampleCsv": "Minta-CSV",
  "import.sampleJson": "Minta-JSON",
  "import.help":
    "A mintafájlok már ennek az ügyfélnek a fiókjait tartalmazzák. A targets oszlopba a fiók azonosítója kerül, több fiókot | jellel válassz el.",
  "import.noAccounts":
    "Ennek az ügyfélnek még nincs csatlakoztatott fiókja. Előbb csatlakoztass egyet.",
  "import.checking": "Fájl ellenőrzése…",
  "import.ready": "Minden rendben: {count} vázlat jön létre.",
  "import.hasErrors":
    "{count} hibát találtunk. Javítsd a fájlt, és töltsd fel újra.",
  "import.lineError": "{line}. sor: {message}",
  "import.previewLabel": "Az import előnézete",
  "import.col.line": "Sor",
  "import.col.date": "Dátum",
  "import.col.channels": "Csatornák",
  "import.col.text": "Szöveg",
  "import.col.result": "Eredmény",
  "import.rowOk": "Rendben",
  "import.submit": "Importálás",
  "import.done": "{count} vázlat importálva.",
  "import.failed": "Nem sikerült feldolgozni a fájlt. Próbáld újra.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
