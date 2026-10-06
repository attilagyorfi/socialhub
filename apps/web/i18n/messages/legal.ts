// Public legal pages (privacy, terms, data deletion).
const en = {
  "title.privacy": "Privacy Policy",
  "title.terms": "Terms of Service",
  "title.deletion": "Data deletion instructions",
  draftNotice:
    "Draft information. Professional legal review is required before production launch.",
  "deletion.user":
    "Signed-in users can download their personal data and request account deletion under Settings → Privacy and data retention. Account deletion begins after a 24-hour grace period and can be cancelled before processing. A sole organization owner must first transfer ownership or delete the organization.",
  "deletion.organization":
    "Organization owners can request deletion from the same screen. Live social-provider connections must be disconnected and revoked first. Organization deletion begins after a 72-hour grace period, removes tenant records and stored media, and can be cancelled before processing.",
  placeholder:
    "This page is a placeholder, not a legal guarantee. The production operator must publish the controller identity, lawful bases, retention periods, subprocessors, international transfer arrangements, data-subject contact details and applicable contractual terms before collecting production data.",
} as const;

const hu = {
  "title.privacy": "Adatkezelési tájékoztató",
  "title.terms": "Felhasználási feltételek",
  "title.deletion": "Útmutató az adatok törléséhez",
  draftNotice:
    "Tervezet. Éles indulás előtt szakmai jogi ellenőrzés szükséges.",
  "deletion.user":
    "Bejelentkezett felhasználóként a Beállítások → Adatvédelem és adatmegőrzés menüpontban letöltheted a személyes adataidat, és kérheted a fiókod törlését. A fiók törlése 24 órás türelmi idő után indul, és a feldolgozás előtt visszavonható. Ha egy szervezetnek te vagy az egyedüli tulajdonosa, előbb át kell adnod a tulajdonjogot, vagy törölnöd kell a szervezetet.",
  "deletion.organization":
    "A szervezet tulajdonosai ugyanezen a képernyőn kérhetik a szervezet törlését. Előbb az élő közösségimédia-kapcsolatokat le kell választani és a hozzáféréseket vissza kell vonni. A szervezet törlése 72 órás türelmi idő után indul, eltávolítja a szervezet rekordjait és tárolt médiáit, és a feldolgozás előtt visszavonható.",
  placeholder:
    "Ez az oldal ideiglenes helykitöltő, nem minősül jogi kötelezettségvállalásnak. Az éles üzemeltetőnek az éles adatok gyűjtése előtt közzé kell tennie az adatkezelő azonosító adatait, az adatkezelés jogalapjait, a megőrzési időket, az adatfeldolgozókat, a harmadik országba történő adattovábbítás feltételeit, az érintettek kapcsolattartási elérhetőségeit és az alkalmazandó szerződési feltételeket.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
