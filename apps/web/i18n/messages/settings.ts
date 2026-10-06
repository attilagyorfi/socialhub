// Personal settings: password, privacy, time zone and language.
const en = {
  "password.title": "Change password",
  "password.mismatch": "The new passwords do not match.",
  "password.failed":
    "Password change failed. Check your current password and try again.",
  "password.changed": "Password changed. Other sessions have been signed out.",
  "password.offline": "Unable to connect. Please try again.",
  "password.current": "Current password",
  "password.new": "New password",
  "password.minLength": "At least 12 characters.",
  "password.confirm": "Confirm new password",
  "password.saving": "Saving…",
  "privacy.title": "Privacy and data retention",
  "privacy.subtitle":
    "Export personal data or manage verified deletion requests.",
  "privacy.export.title": "Personal data export",
  "privacy.export.body":
    "Download your profile, memberships, authored content, approval activity and audit events as JSON. Passwords, sessions and provider credentials are excluded.",
  "privacy.export.download": "Download my data",
  "privacy.retention.title": "Organization retention",
  "privacy.retention.body":
    "Completed operational records older than this period are removed by the worker. Active posts and media remain available.",
  "privacy.retention.days": "Retention days",
  "privacy.retention.save": "Save retention",
  "privacy.deletion.title": "Deletion requests",
  "privacy.deletion.account": "Account deletion: {status}",
  "privacy.deletion.organization": "Organization deletion: {status}",
  "privacy.deletion.scheduledFor": "Scheduled for {date}",
  "privacy.deletion.cancel": "Cancel request",
  "privacy.deletion.deleteAccount": "Delete my account",
  "privacy.deletion.accountBody":
    "Deletion starts after 24 hours and can be cancelled before processing. You must transfer ownership of organizations where you are the sole owner.",
  "privacy.deletion.confirmEmail": "Confirm your email address",
  "privacy.deletion.requestAccount": "Request account deletion",
  "privacy.deletion.deleteOrganization": "Delete {name}",
  "privacy.deletion.organizationBody":
    "This permanently removes all clients, content, analytics and stored media after 72 hours. Live provider grants must be disconnected and revoked first.",
  "privacy.deletion.confirmOrganization": "Type the organization name",
  "privacy.deletion.requestOrganization": "Request organization deletion",
  "privacy.status.PENDING": "pending",
  "privacy.status.RUNNING": "running",
  "privacy.status.COMPLETED": "completed",
  "privacy.status.FAILED": "failed",
  "privacy.status.CANCELLED": "cancelled",
  "timezone.title": "Date and time",
  "timezone.subtitle": "Scheduled times are stored safely in UTC.",
  "timezone.label": "Display timezone",
  "timezone.save": "Save timezone",
  "timezone.useDevice": "Use device timezone",
  "timezone.note":
    "Calendar dates, post schedules, approvals and activity timestamps use this personal setting. Use an IANA timezone such as Europe/Budapest.",
  "language.title": "Language",
  "language.label": "Interface language",
  "language.help":
    "Your interface language. Client-facing pages use the client's language.",
} as const;

const hu = {
  "password.title": "Jelszó módosítása",
  "password.mismatch": "Az új jelszavak nem egyeznek.",
  "password.failed":
    "Nem sikerült módosítani a jelszót. Ellenőrizd a jelenlegi jelszavad, és próbáld újra.",
  "password.changed":
    "Jelszó módosítva. A többi munkamenetből kijelentkeztettünk.",
  "password.offline": "Nem sikerült kapcsolódni. Próbáld újra.",
  "password.current": "Jelenlegi jelszó",
  "password.new": "Új jelszó",
  "password.minLength": "Legalább 12 karakter.",
  "password.confirm": "Új jelszó megerősítése",
  "password.saving": "Mentés…",
  "privacy.title": "Adatvédelem és adatmegőrzés",
  "privacy.subtitle":
    "Exportáld a személyes adataidat, vagy kezeld az ellenőrzött törlési kérelmeket.",
  "privacy.export.title": "Személyes adatok exportja",
  "privacy.export.body":
    "Töltsd le JSON-ban a profilodat, tagságaidat, az általad írt tartalmakat, a jóváhagyási tevékenységedet és a naplóeseményeket. A jelszavak, munkamenetek és szolgáltatói hitelesítő adatok nem kerülnek bele.",
  "privacy.export.download": "Adataim letöltése",
  "privacy.retention.title": "Szervezeti adatmegőrzés",
  "privacy.retention.body":
    "Az ennél régebbi, lezárt üzemeltetési rekordokat a háttérfolyamat törli. Az aktív posztok és a média megmaradnak.",
  "privacy.retention.days": "Megőrzés (nap)",
  "privacy.retention.save": "Megőrzés mentése",
  "privacy.deletion.title": "Törlési kérelmek",
  "privacy.deletion.account": "Fióktörlés: {status}",
  "privacy.deletion.organization": "Szervezet törlése: {status}",
  "privacy.deletion.scheduledFor": "Ütemezve: {date}",
  "privacy.deletion.cancel": "Kérelem visszavonása",
  "privacy.deletion.deleteAccount": "Fiókom törlése",
  "privacy.deletion.accountBody":
    "A törlés 24 óra elteltével indul, és a feldolgozás előtt visszavonható. Azoknak a szervezeteknek a tulajdonjogát, amelyeknek egyedüli tulajdonosa vagy, előbb át kell adnod.",
  "privacy.deletion.confirmEmail": "Erősítsd meg az e-mail-címed",
  "privacy.deletion.requestAccount": "Fióktörlés kérése",
  "privacy.deletion.deleteOrganization": "{name} törlése",
  "privacy.deletion.organizationBody":
    "72 óra elteltével véglegesen törli az összes ügyfelet, tartalmat, analitikát és tárolt médiát. Előbb az élő szolgáltatói kapcsolatokat le kell választani és vissza kell vonni.",
  "privacy.deletion.confirmOrganization": "Írd be a szervezet nevét",
  "privacy.deletion.requestOrganization": "Szervezet törlésének kérése",
  "privacy.status.PENDING": "függőben",
  "privacy.status.RUNNING": "folyamatban",
  "privacy.status.COMPLETED": "befejezve",
  "privacy.status.FAILED": "sikertelen",
  "privacy.status.CANCELLED": "visszavonva",
  "timezone.title": "Dátum és idő",
  "timezone.subtitle":
    "Az ütemezett időpontokat biztonságosan, UTC-ben tároljuk.",
  "timezone.label": "Megjelenített időzóna",
  "timezone.save": "Időzóna mentése",
  "timezone.useDevice": "Eszköz időzónájának használata",
  "timezone.note":
    "A naptár dátumai, a posztok ütemezése, a jóváhagyások és a tevékenységek időbélyegei ezt a személyes beállítást használják. Adj meg egy IANA-időzónát, például Europe/Budapest.",
  "language.title": "Nyelv",
  "language.label": "Felület nyelve",
  "language.help":
    "A felület nyelve. Az ügyfeleknek szóló oldalak az ügyfél nyelvén jelennek meg.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
