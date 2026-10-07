// Status page for Meta data deletion requests.
const en = {
  title: "Data deletion request",
  privacyLink: "Privacy Policy",
  "status.COMPLETED": "Your data deletion request has been completed.",
  code: "Confirmation code: {code}",
  requested: "Requested: {date}",
  completed: "Completed: {date}",
  scope:
    "We deleted the Facebook and Instagram access tokens your account granted to G2A Social Hub, disconnected the accounts connected through it and removed their profile pictures. Posts already published on Facebook or Instagram are managed by Meta and are not affected.",
  notFound:
    "We could not find a data deletion request with this confirmation code.",
  contact: "Questions: info@g2amarketing.hu",
} as const;

const hu = {
  title: "Adattörlési kérelem",
  privacyLink: "Adatkezelési tájékoztató",
  "status.COMPLETED": "Az adattörlési kérelmedet teljesítettük.",
  code: "Megerősítő kód: {code}",
  requested: "Beérkezett: {date}",
  completed: "Teljesítve: {date}",
  scope:
    "Töröltük azokat a Facebook- és Instagram-hozzáférési tokeneket, amelyeket a fiókod a G2A Social Hubnak adott, leválasztottuk az ezen keresztül csatlakoztatott fiókokat, és eltávolítottuk a profilképeiket. A Facebookon vagy Instagramon már megjelent posztokat a Meta kezeli, ezeket a törlés nem érinti.",
  notFound: "Ezzel a megerősítő kóddal nem találunk adattörlési kérelmet.",
  contact: "Kérdés esetén: info@g2amarketing.hu",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
