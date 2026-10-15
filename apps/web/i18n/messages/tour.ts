// Guided product tour: controls and the copy of each tour step.
const en = {
  button: "Product tour",
  counter: "{current} / {total}",
  back: "Back",
  next: "Next",
  finish: "Finish",
  skip: "Skip tour",
  close: "Close tour",
  "welcome.title": "Welcome to G2A Social Hub!",
  "welcome.body":
    "Let’s take a quick look around. It takes less than a minute and you can leave any time.",
  "client.title": "Switch between clients",
  "client.body":
    "Choose the client you are working on here. Posts, media and connected accounts are kept separate for every client.",
  "navigation.title": "Everything in one place",
  "navigation.body":
    "The sidebar takes you to posts, media, analytics, approvals, your team and settings.",
  "create.title": "Create a post",
  "create.body":
    "One idea, every network: write it once, fine-tune it per network, then send it for approval or schedule it.",
  "calendar.title": "Calendar",
  "calendar.body":
    "See what goes out and when. Drag a post to another day to reschedule it.",
  "comments.title": "Comments",
  "comments.body":
    "Comments from every network in one inbox: reply and mark what you have already handled.",
  "help.title": "Need a refresher?",
  "help.body": "Click this button any time to restart the tour.",
};

const hu = {
  button: "Bemutató",
  counter: "{current} / {total}",
  back: "Vissza",
  next: "Tovább",
  finish: "Kész",
  skip: "Bemutató kihagyása",
  close: "Bemutató bezárása",
  "welcome.title": "Üdv a G2A Social Hubban!",
  "welcome.body":
    "Mutatunk egy gyors kört a legfontosabb részekről. Kevesebb mint egy perc, és bármikor kiléphetsz.",
  "client.title": "Váltás az ügyfelek között",
  "client.body":
    "Itt választod ki, melyik ügyféllel dolgozol. A posztok, a média és a fiókok minden ügyfélnél külön élnek.",
  "navigation.title": "Minden egy helyen",
  "navigation.body":
    "Az oldalsávból éred el a posztokat, a médiatárat, az elemzéseket, a jóváhagyásokat, a csapatot és a beállításokat.",
  "create.title": "Új poszt",
  "create.body":
    "Egy ötlet, minden hálózat: írd meg egyszer, igazítsd hálózatonként, aztán küldd jóváhagyásra vagy ütemezd.",
  "calendar.title": "Naptár",
  "calendar.body":
    "Itt látod, mi mikor megy ki. Egy posztot másik napra húzva át is ütemezheted.",
  "comments.title": "Hozzászólások",
  "comments.body":
    "Minden hálózat kommentje egy helyen: válaszolj, és jelöld, amit már elintéztél.",
  "help.title": "Újranéznéd?",
  "help.body": "Erre a gombra kattintva bármikor újraindíthatod a bemutatót.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
