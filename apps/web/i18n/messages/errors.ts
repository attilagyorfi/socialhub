// Server error codes. English keeps the server's own (more specific)
// message; Hungarian replaces it with these texts. VALIDATION and
// MOCK_* codes carry dynamic details and are left to the server.
const en = {
  AI_NOT_CONFIGURED: "Configure the AI model and API key.",
  AI_REQUEST_FAILED: "The AI provider could not complete the request.",
  ALREADY_MEMBER: "This user is already a member.",
  ALREADY_PUBLISHED: "Some content has already published.",
  ANALYTICS_JOB_MISSING: "Analytics job missing.",
  ANALYTICS_PROVIDER_UNSUPPORTED:
    "Analytics is not configured for this provider.",
  ANALYTICS_REMOTE_ID_MISSING: "Published target has no provider identifier.",
  ANALYTICS_SYNC_FAILED: "Analytics synchronization failed.",
  APPROVAL_REQUIRED: "Approval is required first.",
  ASSIGNEE_REQUIRED: "This review is assigned to another reviewer.",
  BRAND_GUARDRAIL: "Brand review blocked approval.",
  CLIENT_INVALID: "A selected client is invalid.",
  CLIENT_REQUIRED: "Choose at least one client for this role.",
  COMMENT_REQUIRED: "Please explain the requested changes or enter a comment.",
  CONFIRMATION_MISMATCH: "The confirmation does not match.",
  CREDENTIAL_REVOCATION_REQUIRED: "Provider credentials must be revoked first.",
  CSRF: "Invalid request origin",
  DELIVERY_UNCERTAIN: "Meta may already have published this post.",
  DISCONNECTED: "Account disconnected",
  DUPLICATE_TARGET: "Choose each account only once.",
  EMAIL_MISMATCH: "Sign in with the invited email address.",
  EXPIRED: "This approval link is invalid or expired.",
  FILE_NAME: "Use a file name up to 200 characters.",
  FILE_REQUIRED: "Choose a file.",
  FILE_SIZE: "The file size is invalid.",
  FILE_TYPE: "The file type is not supported.",
  FORBIDDEN: "You do not have permission for this action.",
  INVALID_ACCOUNT: "Choose a connected account from this client.",
  INVALID_CURSOR: "The post list cursor is invalid.",
  INVALID_IMAGE: "The image is damaged, unsupported or exceeds 25 megapixels.",
  INVALID_MEDIA: "Media must be ready and belong to this client.",
  INVALID_RANGE: "Choose a valid date range.",
  INVALID_REVIEWER: "Choose a reviewer with approval access to this client.",
  INVALID_STATE: "This action is not available in the post's current state.",
  INVALID_TIME: "Choose a valid future time.",
  INVALID_VIDEO: "The video is damaged or unsupported.",
  INVALID_WORKFLOW: "Choose a valid approval workflow.",
  INVITATION_INVALID: "This invitation is invalid or expired.",
  MEDIA_IN_USE: "This file is attached to a post.",
  MEDIA_MISSING: "The attachment is missing from storage. Upload it again.",
  MEDIA_PROCESSING_UNAVAILABLE: "Processing failed.",
  META_ACCOUNT_UNAVAILABLE: "The Meta account is not connected.",
  META_CREDENTIAL_INVALID:
    "The stored Meta credential is invalid. Reconnect the account.",
  META_DELIVERY_UNCERTAIN:
    "Meta did not confirm whether the content was published.",
  META_DISABLED: "Meta integration is not enabled.",
  META_INSTAGRAM_INVALID: "The Instagram account or media is unavailable.",
  META_LOGIN_CONFIG_INVALID:
    "Invalid Facebook Login for Business configuration ID.",
  META_MEDIA_NOT_PUBLIC: "Meta cannot download media from a local storage URL.",
  META_MEDIA_REJECTED: "Instagram could not process the media.",
  META_MEDIA_PROCESSING: "The media is still being processed.",
  META_MEDIA_TOO_LARGE:
    "The image cannot be reduced below the Instagram 8 MB limit.",
  META_MEDIA_UNSUPPORTED: "One media attachment per post is supported.",
  META_NOT_CONFIGURED: "Meta application credentials are required.",
  META_NO_PAGES: "No Facebook Page with content publishing access was found.",
  META_PAGE_ACCESS_LOST: "Page access is no longer available.",
  META_RATE_LIMIT: "Meta rate limit reached.",
  META_RECONCILIATION_FAILED: "Meta delivery reconciliation failed.",
  META_REJECTED: "Meta rejected the request.",
  META_RESPONSE_INVALID: "Meta returned an invalid response.",
  META_REVOCATION_FAILED: "Meta did not confirm permission revocation.",
  META_TOKEN_EXPIRED: "The Meta authorization expired. Reconnect the account.",
  META_TOKEN_INVALID: "The Meta authorization is no longer valid.",
  META_UNAVAILABLE: "Meta is temporarily unavailable.",
  META_VERSION_INVALID: "META_GRAPH_VERSION must use the vNN.N format.",
  NOT_FOUND: "Not found.",
  NO_CLIENT_REVIEW: "No client review is waiting for this post.",
  NO_EXPIRED_REVIEW: "No expired review is waiting for this post.",
  NO_INTERNAL_REVIEW: "No active internal review is waiting for this post.",
  OAUTH_CODE_MISSING: "OAuth code missing.",
  OAUTH_DENIED: "Meta authorization was cancelled.",
  OAUTH_SESSION_MISMATCH: "OAuth session mismatch.",
  OAUTH_STATE_INVALID: "OAuth state expired.",
  OWNER_PROTECTED: "Owner access cannot be changed here.",
  OWNER_REQUIRED: "Only an owner can do this.",
  PRIVACY_REQUEST_EXISTS: "A deletion request already exists.",
  PROVIDER_NOT_CONFIGURED: "This provider is not configured.",
  PROVIDER_UNAVAILABLE: "Provider request failed",
  PUBLISHING_IN_PROGRESS:
    "Publishing is in progress. Try again once it has finished.",
  PUBLISHING_STARTED: "Publishing has already started for this post.",
  RATE_LIMIT: "Too many requests. Try again shortly.",
  REMINDER_COOLDOWN: "A reminder was sent less than one hour ago.",
  REQUEST_CLOSED: "This privacy request is already closed.",
  REQUEST_RUNNING: "This deletion is already being processed.",
  REVIEWER_REQUIRED: "Choose an internal reviewer.",
  REVOCATION_REQUIRED:
    "Revoke the provider connection before removing credentials.",
  ROLE_INVALID: "Choose an assignable role.",
  SELF_CHANGE: "Another owner must change your access.",
  SELF_REMOVE: "You cannot remove your own membership.",
  SELF_REVIEW: "Choose a reviewer other than the post author.",
  SOLE_OWNER: "Transfer ownership before deleting your account.",
  STALE_APPROVAL:
    "This request has already been decided or the post has changed.",
  STALE_POST: "This post changed since the calendar loaded.",
  UNAUTHENTICATED: "Please sign in.",
  UNKNOWN_ACTION: "Unknown action.",
  UPLOAD_INCOMPLETE: "The file has not finished uploading.",
  UPLOAD_STATE: "This upload cannot be completed.",
  WORKER_INTERRUPTED: "The worker stopped.",
  INTERNAL_ERROR: "Something went wrong.",
  SERVICE_UNAVAILABLE: "The service is unavailable.",
} as const;

const hu = {
  AI_NOT_CONFIGURED: "Állítsd be az AI-modellt és az API-kulcsot.",
  AI_REQUEST_FAILED: "Az AI-szolgáltató nem tudta teljesíteni a kérést.",
  ALREADY_MEMBER: "Ez a felhasználó már tag.",
  ALREADY_PUBLISHED:
    "A tartalom egy része már megjelent; a visszavonás ezt nem tudja törölni.",
  ANALYTICS_JOB_MISSING: "Hiányzik az analitikai feladat.",
  ANALYTICS_PROVIDER_UNSUPPORTED:
    "Ennél a szolgáltatónál nincs beállítva analitika.",
  ANALYTICS_REMOTE_ID_MISSING:
    "A közzétett tartalomnak nincs szolgáltatói azonosítója.",
  ANALYTICS_SYNC_FAILED: "Nem sikerült szinkronizálni az analitikát.",
  APPROVAL_REQUIRED: "Ehhez előbb jóváhagyás szükséges.",
  ASSIGNEE_REQUIRED: "Ezt az ellenőrzést másik jóváhagyóhoz rendelték.",
  BRAND_GUARDRAIL: "A márkaellenőrzés megakadályozta a jóváhagyást.",
  CLIENT_INVALID: "Az egyik kiválasztott ügyfél érvénytelen.",
  CLIENT_REQUIRED: "Ehhez a szerepkörhöz válassz legalább egy ügyfelet.",
  COMMENT_REQUIRED: "Írd le, milyen módosítást kérsz, vagy írj megjegyzést.",
  CONFIRMATION_MISMATCH:
    "A megerősítés nem egyezik. Pontosan írd be a kért szöveget.",
  CREDENTIAL_REVOCATION_REQUIRED:
    "Előbb válaszd le a közösségimédia-fiókokat és vond vissza a hozzáférést.",
  CSRF: "Érvénytelen kérésforrás.",
  DELIVERY_UNCERTAIN:
    "Lehet, hogy a Meta már közzétette ezt a posztot. Amíg ez nincs megerősítve, nem vonható vissza; ellenőrizd a Beállítások → Üzemeltetés részben.",
  DISCONNECTED: "A fiók le van választva.",
  DUPLICATE_TARGET: "Minden fiókot csak egyszer válassz ki.",
  EMAIL_MISMATCH: "A meghívott e-mail-címmel jelentkezz be.",
  EXPIRED: "Ez a jóváhagyási link érvénytelen vagy lejárt.",
  FILE_NAME: "A fájlnév legfeljebb 200 karakter lehet.",
  FILE_REQUIRED: "Válassz egy fájlt.",
  FILE_SIZE:
    "A fájl mérete nem megfelelő (1 bájt és 20 MB között kell lennie).",
  FILE_TYPE:
    "A fájltípus nem támogatott. PNG, JPEG, WebP képet vagy MP4 videót tölts fel.",
  FORBIDDEN: "Ehhez a művelethez nincs jogosultságod.",
  INVALID_ACCOUNT: "Ennek az ügyfélnek egy csatlakoztatott fiókját válaszd.",
  INVALID_CURSOR: "A posztlista lapozása elavult. Kezdd újra az első oldalról.",
  INVALID_IMAGE: "A kép sérült, nem támogatott, vagy nagyobb 25 megapixelnél.",
  INVALID_MEDIA:
    "A médiafájl hiányzik, még nincs kész, vagy nem ehhez az ügyfélhez tartozik.",
  INVALID_RANGE: "Válassz érvényes időszakot.",
  INVALID_REVIEWER:
    "Olyan jóváhagyót válassz, akinek van jóváhagyási joga ennél az ügyfélnél.",
  INVALID_STATE: "Ez a művelet a poszt jelenlegi állapotában nem végezhető el.",
  INVALID_TIME: "Válassz érvényes, jövőbeli időpontot.",
  INVALID_VIDEO:
    "A videó sérült vagy nem támogatott. H.264 MP4, legfeljebb 10 perc és oldalanként 4096 pixel.",
  INVALID_WORKFLOW:
    "Válassz belső, ügyféloldali, vagy belső majd ügyféloldali jóváhagyást.",
  INVITATION_INVALID: "Ez a meghívó érvénytelen vagy lejárt.",
  MEDIA_IN_USE: "Ez a fájl egy poszthoz van csatolva.",
  MEDIA_MISSING: "A csatolmány hiányzik a tárhelyről. Töltsd fel újra.",
  MEDIA_PROCESSING_UNAVAILABLE: "A feldolgozás nem sikerült.",
  META_ACCOUNT_UNAVAILABLE: "A Meta-fiók nincs csatlakoztatva.",
  META_CREDENTIAL_INVALID:
    "A tárolt Meta-hozzáférés érvénytelen. Csatlakoztasd újra a fiókot.",
  META_DELIVERY_UNCERTAIN:
    "A Meta nem erősítette meg, hogy megjelent-e a tartalom. Újrapróbálás előtt nézd meg a fiókot.",
  META_DISABLED: "A Meta-integráció nincs bekapcsolva.",
  META_INSTAGRAM_INVALID:
    "Az Instagram-fiók vagy a csatolt média nem érhető el.",
  META_LOGIN_CONFIG_INVALID:
    "Érvénytelen Facebook Login for Business konfigurációs azonosító (META_LOGIN_CONFIG_ID).",
  META_MEDIA_NOT_PUBLIC:
    "A Meta nem tud letölteni helyi tárhelyről. Állíts be nyilvános S3-végpontot.",
  META_MEDIA_REJECTED: "A Meta nem tudta feldolgozni a médiát.",
  META_MEDIA_PROCESSING:
    "A Meta még feldolgozza a videót. A közzétételt automatikusan újrapróbáljuk.",
  META_MEDIA_TOO_LARGE:
    "A képet nem sikerült az Instagram 8 MB-os korlátja alá csökkenteni.",
  META_MEDIA_UNSUPPORTED:
    "A Meta-kapcsolat jelenleg posztonként egy csatolmányt támogat.",
  META_NOT_CONFIGURED: "Hiányoznak a Meta-alkalmazás adatai és az API-verzió.",
  META_NO_PAGES:
    "Nem találtunk olyan Facebook-oldalt, amelyre van közzétételi jogod.",
  META_PAGE_ACCESS_LOST: "Már nincs hozzáférésed az oldalhoz.",
  META_RATE_LIMIT: "Elérted a Meta kéréskorlátját. Próbáld újra később.",
  META_RECONCILIATION_FAILED: "Nem sikerült ellenőrizni a Meta-közzétételt.",
  META_REJECTED:
    "A Meta elutasította a kérést. Ellenőrizd a fiók jogosultságait és a tartalmat.",
  META_RESPONSE_INVALID: "A Meta érvénytelen választ adott.",
  META_REVOCATION_FAILED:
    "A Meta nem erősítette meg a hozzáférés visszavonását.",
  META_TOKEN_EXPIRED: "A Meta-engedély lejárt. Csatlakoztasd újra a fiókot.",
  META_TOKEN_INVALID: "A Meta-engedély már nem érvényes.",
  META_UNAVAILABLE: "A Meta átmenetileg nem érhető el.",
  META_VERSION_INVALID: "A META_GRAPH_VERSION formátuma vNN.N kell legyen.",
  NOT_FOUND: "A keresett elem nem található.",
  NO_CLIENT_REVIEW: "Ennél a posztnál nincs függő ügyféloldali jóváhagyás.",
  NO_EXPIRED_REVIEW: "Ennél a posztnál nincs lejárt jóváhagyás.",
  NO_INTERNAL_REVIEW: "Ennél a posztnál nincs aktív belső jóváhagyás.",
  OAUTH_CODE_MISSING: "Hiányzik az OAuth-kód.",
  OAUTH_DENIED: "A Meta-engedélyezés megszakadt.",
  OAUTH_SESSION_MISMATCH:
    "Az OAuth-munkamenet nem egyezik. Kezdd újra a csatlakoztatást.",
  OAUTH_STATE_INVALID:
    "Az OAuth-folyamat lejárt. Kezdd újra a csatlakoztatást.",
  OWNER_PROTECTED: "A tulajdonos hozzáférése itt nem módosítható.",
  OWNER_REQUIRED: "Ezt csak a szervezet tulajdonosa teheti meg.",
  PRIVACY_REQUEST_EXISTS: "Már van folyamatban törlési kérelem.",
  PROVIDER_NOT_CONFIGURED: "Ez a közösségimédia-szolgáltató nincs beállítva.",
  PROVIDER_UNAVAILABLE: "A szolgáltatóhoz intézett kérés nem sikerült.",
  PUBLISHING_IN_PROGRESS:
    "A közzététel folyamatban van. Próbáld újra, ha befejeződött.",
  PUBLISHING_STARTED: "Ennek a posztnak a közzététele már elindult.",
  RATE_LIMIT: "Túl sok kérés. Próbáld újra kicsit később.",
  REMINDER_COOLDOWN: "Egy órán belül már küldtünk emlékeztetőt.",
  REQUEST_CLOSED: "Ez az adatvédelmi kérelem már lezárult.",
  REQUEST_RUNNING: "Ez a törlés már folyamatban van.",
  REVIEWER_REQUIRED: "Válassz belső jóváhagyót.",
  REVOCATION_REQUIRED:
    "A hozzáférési adatok törlése előtt vond vissza a fiókkapcsolatot.",
  ROLE_INVALID: "Kiosztható szerepkört válassz.",
  SELF_CHANGE:
    "A saját hozzáférésedet egy másik tulajdonosnak kell módosítania.",
  SELF_REMOVE: "A saját tagságodat nem távolíthatod el.",
  SELF_REVIEW: "A poszt szerzőjétől eltérő jóváhagyót válassz.",
  SOLE_OWNER:
    "Egyedüli tulajdonos vagy: a fiókod törlése előtt add át a tulajdonjogot, vagy töröld a szervezetet.",
  STALE_APPROVAL:
    "Erről a kérésről már döntöttek, vagy a poszt időközben megváltozott.",
  STALE_POST:
    "A poszt megváltozott, mióta a naptár betöltődött. Frissíts, és próbáld újra.",
  UNAUTHENTICATED: "Jelentkezz be.",
  UNKNOWN_ACTION: "Ismeretlen művelet.",
  UPLOAD_INCOMPLETE: "A fájl feltöltése még nem fejeződött be.",
  UPLOAD_STATE: "Ez a feltöltés nem fejezhető be.",
  WORKER_INTERRUPTED: "A háttérfolyamat leállt.",
  INTERNAL_ERROR: "Váratlan hiba történt. Próbáld újra.",
  SERVICE_UNAVAILABLE:
    "A szolgáltatás nem érhető el. Ellenőrizd, hogy fut-e az adatbázis és a Redis.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
