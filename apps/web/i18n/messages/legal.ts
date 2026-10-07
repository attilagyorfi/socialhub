// Public legal pages (privacy, terms, data deletion).
// Bodies are plain text: "\n\n" separates paragraphs, lines starting with "• "
// are rendered as list items by app/legal/[page]/page.tsx.
const en = {
  "title.privacy": "Privacy Policy",
  "title.terms": "Terms of Use",
  "title.deletion": "Data deletion instructions",
  draftNotice:
    "Draft. This document has not yet been reviewed by a legal professional; professional legal review is required before production launch.",
  lastUpdated: "Last updated: 2026-10-07",

  // ---------------------------------------------------------------- Privacy
  "privacy.s1.title": "1. Data controller",
  "privacy.s1.body":
    'This Privacy Policy explains how personal data is processed in G2A Social Hub (the "Service").\n\nThe data controller is:\n• G2A Marketing Bt. (Hungarian limited partnership)\n• Registered office: [registered office]\n• Company registration number: [company registration number]\n• Tax number: [tax number]\n• Email: info@g2amarketing.hu\n• Phone: +36 30 190 2575\n\nFor any question about this policy or your personal data, please contact us at info@g2amarketing.hu.',

  "privacy.s2.title": "2. About the Service",
  "privacy.s2.body":
    'G2A Social Hub is a social media management tool used by G2A Marketing Bt. (the "Agency") and its clients. It is used to plan, write, approve, schedule and publish posts on social media accounts managed by the Agency, and to view analytics for those accounts.\n\nThe Service is used by:\n• Agency staff, with roles such as owner, admin, social manager, content creator or viewer;\n• client users who review and approve content for their own brand;\n• external client reviewers, who can approve or reject a post through a secure, tokenized link without creating an account.\n\nThe Service is not intended for consumers or for children, and it is not offered to the general public.',

  "privacy.s3.title": "3. Personal data we process",
  "privacy.s3.body":
    "Depending on how you use the Service, we process the following categories of data:\n• Account data: name, email address, password (stored only as a secure hash by our authentication system), sign-in sessions, time zone and interface language.\n• Organization and client workspace data: the organizations and client workspaces you belong to, your role and permissions, and invitations.\n• Content: post texts, captions, hashtags, schedules and media files (images and videos) uploaded to the Service.\n• Approval data: approval decisions, comments and, for external reviewers using an approval link, the name you optionally enter and your comment.\n• Audit and security logs: records of important actions (for example sign-in, publishing, permission changes), together with technical data such as time stamps.\n• AI feature data: if you use the AI writing features, the prompts you enter and the generated texts.\n• Email delivery logs: records of transactional emails sent to you (for example invitations, approval requests, notifications) and their delivery status.\n• Data received from Meta (Facebook and Instagram), as described in section 4.",

  "privacy.s4.title": "4. Data received from Meta (Facebook and Instagram)",
  "privacy.s4.body":
    "When an authorized user connects a Facebook Page or an Instagram professional account through Facebook Login for Business, the Service receives the following from Meta, within the permissions the user grants:\n• a user access token (exchanged for a long-lived token) and Page access tokens;\n• the Page's ID, name and profile picture;\n• the connected Instagram professional account's ID, username and profile picture;\n• the IDs of posts published through the Service;\n• insights for the connected Pages, posts and Instagram accounts, such as reach, views, impressions and engagement counts (reactions, comments, shares, saves).\n\nHow we use this data:\n• Access tokens are encrypted at rest using AES-256-GCM, are never shown to any user and are used only to publish content that the Agency and/or the client has approved, and to read insights for the connected accounts.\n• Page and account details are used to show which accounts are connected and to let users choose where a post is published.\n• Insights are shown to the Agency and the relevant client in the Analytics section of the Service.\n\nWhat we do not do:\n• We do not sell any data and we do not use Meta data for advertising.\n• We do not profile the people who interact with the connected Pages or accounts.\n• The Service does not read private messages and does not collect personal data of people who comment on, react to or otherwise interact with the connected Pages or accounts.\n• We use Meta data only in accordance with the Meta Platform Terms and Developer Policies.",

  "privacy.s5.title": "5. Purposes and legal bases",
  "privacy.s5.body":
    "We process personal data for the following purposes and on the following legal bases under the EU General Data Protection Regulation (GDPR):\n• Providing the Service (accounts, workspaces, content planning, approval, publishing, analytics): performance of the contract between the Agency and its client, or the Agency's legitimate interest in providing the agreed services to its clients (GDPR Article 6(1)(b) and (f)).\n• Approval by external reviewers through a link: the legitimate interest of the Agency and its client in documenting content approval (Article 6(1)(f)).\n• Security, audit logs and abuse prevention: legitimate interest in keeping the Service and the connected accounts secure (Article 6(1)(f)).\n• AI writing features: performance of the contract / legitimate interest, only when a user chooses to use these features (Article 6(1)(b) and (f)).\n• Transactional emails: performance of the contract / legitimate interest in operating the approval workflow (Article 6(1)(b) and (f)).\n• Compliance with legal obligations, for example accounting or responding to authorities (Article 6(1)(c)).\n\nWhere we rely on legitimate interest, you may object to the processing as described in section 10.",

  "privacy.s6.title": "6. Processors and recipients",
  "privacy.s6.body":
    "We use the following service providers (processors) to operate the Service:\n• Vercel – hosting of the web application (Frankfurt, Germany region).\n• Railway – PostgreSQL database, Redis queue and background worker (EU West region).\n• Cloudflare (R2) – storage of uploaded media files.\n• Resend – sending transactional emails (EU region).\n• OpenAI – AI text generation, only when a user uses the AI features.\n\nMeta Platforms (Facebook and Instagram) receives the content that is published to the connected accounts and processes it as an independent controller under its own terms and privacy policy.\n\nWithin the Service, data is visible only to users who have access to the relevant organization or client workspace, according to their role. We do not sell personal data and do not share it with third parties for their own marketing purposes.",

  "privacy.s7.title": "7. International data transfers",
  "privacy.s7.body":
    "Some of our service providers are based in, or may access data from, the United States or other countries outside the European Economic Area. Where personal data is transferred outside the EEA, the transfer is based on an adequacy decision of the European Commission (such as the EU–US Data Privacy Framework, where the provider is certified) or on the European Commission's standard contractual clauses, together with additional safeguards where necessary.",

  "privacy.s8.title": "8. Retention",
  "privacy.s8.body":
    "We keep personal data only for as long as it is needed for the purposes above:\n• Account data is kept while the account exists. When you delete your account, deletion starts after a 24-hour grace period, after which your personal data is erased.\n• Organization data is kept while the organization exists. When an organization is deleted, deletion starts after a 72-hour grace period and removes the organization's records and stored media.\n• Each organization can set a data retention period (in days). After this period, older operational records — approvals, background jobs, webhook events, notifications, metrics, AI generations, invitations, soft-deleted media and posts, and audit logs — are deleted automatically.\n• Meta access tokens are deleted when the account is disconnected, when the app is removed in Facebook settings, or when the organization is deleted.\n• Data that we are required to keep by law (for example accounting records) is kept for the period required by law.",

  "privacy.s9.title": "9. Security",
  "privacy.s9.body":
    "We use appropriate technical and organizational measures to protect personal data, including:\n• encrypted connections (TLS) for all traffic;\n• encryption of social platform access tokens at rest (AES-256-GCM);\n• role-based access control, separately for each client workspace;\n• audit logging of important actions;\n• rate limiting and other measures against abuse.",

  "privacy.s10.title": "10. Your rights",
  "privacy.s10.body":
    "Under the GDPR you have the right to:\n• access your personal data and receive a copy of it;\n• have inaccurate data rectified;\n• have your data erased;\n• restrict the processing of your data;\n• data portability — signed-in users can download their data in JSON format under Settings → Privacy and data retention;\n• object to processing based on legitimate interest.\n\nTo exercise your rights, contact us at info@g2amarketing.hu. We respond without undue delay and within one month at the latest.\n\nIf you believe that the processing of your personal data infringes the law, you may lodge a complaint with the Hungarian National Authority for Data Protection and Freedom of Information (Nemzeti Adatvédelmi és Információszabadság Hatóság, NAIH; website: naih.hu) or with the supervisory authority of your place of residence, and you may also turn to the courts.",

  "privacy.s11.title": "11. Data deletion",
  "privacy.s11.body":
    "You can disconnect your Facebook and Instagram accounts, remove the app in your Facebook settings, delete your account or request deletion by email. Step-by-step instructions are available on our Data deletion instructions page (/legal/deletion).",

  "privacy.s12.title": "12. Cookies",
  "privacy.s12.body":
    "The Service uses only cookies that are necessary for it to work: a session cookie to keep you signed in and a cookie that stores your chosen interface language. We do not use advertising or third-party tracking cookies.",

  "privacy.s13.title": "13. Changes to this policy",
  "privacy.s13.body":
    "We may update this Privacy Policy when the Service or the law changes. The date of the latest update is shown at the top of this page. We inform users of significant changes in the Service or by email.",

  // ------------------------------------------------------------------ Terms
  "terms.s1.title": "1. Provider and scope",
  "terms.s1.body":
    'G2A Social Hub (the "Service") is operated by G2A Marketing Bt. (registered office: [registered office]; company registration number: [company registration number]; tax number: [tax number]; email: info@g2amarketing.hu; phone: +36 30 190 2575) (the "Provider").\n\nThese Terms of Use govern the use of the Service. The Service is provided to the Provider\'s agency staff and to its clients in connection with a separate service agreement between the Provider and the client. If these Terms conflict with that agreement, the agreement prevails.',

  "terms.s2.title": "2. Accounts and access",
  "terms.s2.body":
    "• Access is available by invitation only. Users must provide accurate information and keep their sign-in details confidential.\n• Each user acts within the role assigned to them (for example owner, admin, social manager, content creator, viewer or client reviewer).\n• Approval links sent to external reviewers are personal and must not be forwarded to unauthorized persons.\n• Users must notify the Provider without delay at info@g2amarketing.hu if they suspect unauthorized access to their account.",

  "terms.s3.title": "3. Connecting social media accounts",
  "terms.s3.body":
    "Users may connect Facebook Pages and Instagram professional accounts only if they are authorized to manage those accounts. By connecting an account, the user authorizes the Service to publish content approved in the Service to that account and to read its insights. The connection can be removed at any time in Connected accounts or in the Facebook settings.",

  "terms.s4.title": "4. Acceptable use",
  "terms.s4.body":
    "Users must not use the Service:\n• in breach of the Meta Platform Terms, the Facebook Community Standards, the Instagram Community Guidelines or the terms of any other connected platform;\n• to publish unlawful, infringing, misleading, defamatory, hateful or otherwise harmful content;\n• to send spam or carry out any automated activity that the platforms do not allow;\n• to attempt to access data, workspaces or accounts that they are not authorized to access, or to interfere with the security or operation of the Service.",

  "terms.s5.title": "5. Content and responsibility",
  "terms.s5.body":
    "Users and clients remain the owners of the content they upload. They grant the Provider the rights necessary to store, process and publish that content for the purpose of providing the Service.\n\nThe user or client who approves or publishes a post is responsible for its content, including that it complies with the law and that the necessary rights (for example copyright and image rights) have been obtained.",

  "terms.s6.title": "6. AI features",
  "terms.s6.body":
    "The Service may offer AI-assisted text generation. AI-generated texts are suggestions only; they may be inaccurate or inappropriate and must be reviewed by a person before publication. Prompts are sent to the AI provider only when a user uses these features.",

  "terms.s7.title": "7. Availability",
  "terms.s7.body":
    'The Service is under active development. Test, staging and beta versions are provided "as is" and "as available", without any guarantee of uninterrupted or error-free operation. Publishing depends on the availability of the social platforms, which is outside the Provider\'s control. Service levels, if any, are set out in the separate service agreement.',

  "terms.s8.title": "8. Limitation of liability",
  "terms.s8.body":
    "To the extent permitted by applicable law, the Provider is not liable for indirect or consequential damages, lost profits or data loss, or for damage caused by the operation, decisions or outages of the social platforms. This limitation does not apply to liability that cannot be excluded or limited under mandatory law, in particular for damage caused intentionally or by gross negligence, or for damage to life, physical integrity or health.",

  "terms.s9.title": "9. Suspension and termination",
  "terms.s9.body":
    "The Provider may suspend or terminate a user's access if the user breaches these Terms or if required by law or by a platform. Access also ends when the agreement between the Provider and the client ends. Users can delete their account at any time under Settings → Privacy and data retention. Deletion of data follows the Privacy Policy and the Data deletion instructions.",

  "terms.s10.title": "10. Privacy",
  "terms.s10.body":
    "The processing of personal data in the Service is described in the Privacy Policy (/legal/privacy).",

  "terms.s11.title": "11. Changes to these Terms",
  "terms.s11.body":
    "The Provider may amend these Terms. Users are informed of significant changes in advance, in the Service or by email. Continuing to use the Service after the changes take effect constitutes acceptance of the amended Terms.",

  "terms.s12.title": "12. Governing law and contact",
  "terms.s12.body":
    "These Terms are governed by Hungarian law. Disputes are settled by the courts having jurisdiction under Hungarian law. Questions about these Terms can be sent to info@g2amarketing.hu.",

  // --------------------------------------------------------------- Deletion
  "deletion.s1.title": "Overview",
  "deletion.s1.body":
    "This page explains how to remove data that G2A Social Hub (operated by G2A Marketing Bt.) stores about you and about your Facebook and Instagram accounts. You can use any of the options below.",

  "deletion.s2.title": "1. Disconnect an account in G2A Social Hub",
  "deletion.s2.body":
    "• Sign in and open Connected accounts.\n• Choose Disconnect next to the Facebook Page or Instagram account.\n\nThis revokes the app's permissions at Meta and deletes the stored access tokens. Scheduled posts for that account will no longer be published.",

  "deletion.s3.title": "2. Remove the app in your Facebook settings",
  "deletion.s3.body":
    "• On Facebook, go to Settings & privacy → Settings.\n• Open Business integrations (or Apps and websites).\n• Select G2A Social Hub and choose Remove.\n\nMeta then notifies us automatically through our data deletion callback. We delete the stored access tokens and disconnect the affected accounts. Meta shows you a confirmation code and a link to a status page on this website (/meta/deletion/<code>), where you can check the status of your request.",

  "deletion.s4.title": "3. Delete your G2A Social Hub account",
  "deletion.s4.body":
    "Signed-in users can download their personal data (JSON export) and request account deletion under Settings → Privacy and data retention. Account deletion starts after a 24-hour grace period and can be cancelled before it is processed. A sole organization owner must first transfer ownership or delete the organization.",

  "deletion.s5.title": "4. Delete an organization",
  "deletion.s5.body":
    "Organization owners can request deletion of the organization on the same screen. Connected social accounts must be disconnected first. Organization deletion starts after a 72-hour grace period, removes the organization's records and stored media, and can be cancelled before it is processed.",

  "deletion.s6.title": "5. Request deletion by email",
  "deletion.s6.body":
    "You can also request deletion of your data by email at info@g2amarketing.hu. Please tell us the email address of your account or the name of the Facebook Page or Instagram account concerned. We may ask you to verify your identity, and we respond within one month at the latest.\n\nData that we are required to keep by law is deleted when the legal retention period ends. More information is available in our Privacy Policy (/legal/privacy).",
} as const;

const hu = {
  "title.privacy": "Adatkezelési tájékoztató",
  "title.terms": "Felhasználási feltételek",
  "title.deletion": "Útmutató az adatok törléséhez",
  draftNotice:
    "Tervezet. A dokumentumot jogi szakember még nem ellenőrizte; éles indulás előtt szakmai jogi ellenőrzés szükséges.",
  lastUpdated: "Utolsó frissítés: 2026-10-07",

  // ---------------------------------------------------------------- Privacy
  "privacy.s1.title": "1. Az adatkezelő",
  "privacy.s1.body":
    "Ez a tájékoztató bemutatja, hogyan kezeli a G2A Social Hub szolgáltatás (a továbbiakban: Szolgáltatás) a személyes adatokat.\n\nAz adatkezelő:\n• G2A Marketing Bt.\n• Székhely: [székhely]\n• Cégjegyzékszám: [cégjegyzékszám]\n• Adószám: [adószám]\n• E-mail: info@g2amarketing.hu\n• Telefon: +36 30 190 2575\n\nA tájékoztatóval vagy a személyes adatok kezelésével kapcsolatos kérdések az info@g2amarketing.hu címre küldhetők.",

  "privacy.s2.title": "2. A Szolgáltatásról",
  "privacy.s2.body":
    "A G2A Social Hub közösségimédia-kezelő eszköz, amelyet a G2A Marketing Bt. (a továbbiakban: Ügynökség) és ügyfelei használnak. A Szolgáltatás az Ügynökség által kezelt közösségimédia-fiókok bejegyzéseinek tervezésére, megírására, jóváhagyására, ütemezésére és közzétételére, valamint e fiókok elemzési adatainak megtekintésére szolgál.\n\nA Szolgáltatás felhasználói:\n• az Ügynökség munkatársai (például tulajdonos, adminisztrátor, social manager, tartalomkészítő vagy megtekintő szerepkörrel);\n• az ügyfelek felhasználói, akik a saját márkájukhoz tartozó tartalmakat ellenőrzik és hagyják jóvá;\n• külső ügyféloldali jóváhagyók, akik fiók létrehozása nélkül, biztonságos, egyedi tokennel ellátott hivatkozáson keresztül hagyhatnak jóvá vagy utasíthatnak el egy bejegyzést.\n\nA Szolgáltatás nem fogyasztóknak és nem gyermekeknek szól, és a nagyközönség számára nem érhető el.",

  "privacy.s3.title": "3. A kezelt személyes adatok",
  "privacy.s3.body":
    "A Szolgáltatás használatának módjától függően az Adatkezelő az alábbi adatkategóriákat kezeli:\n• Fiókadatok: név, e-mail-cím, jelszó (kizárólag biztonságos hash formájában, a hitelesítési rendszer által tárolva), bejelentkezési munkamenetek, időzóna és a felület nyelve.\n• Szervezeti és ügyfél-munkaterületi adatok: azok a szervezetek és ügyfél-munkaterületek, amelyekhez a Felhasználó tartozik, a Felhasználó szerepköre és jogosultságai, valamint a meghívók.\n• Tartalmak: a bejegyzések szövegei, képaláírásai, hashtagjei, ütemezése, valamint a Szolgáltatásba feltöltött médiafájlok (képek és videók).\n• Jóváhagyási adatok: jóváhagyási döntések, megjegyzések, továbbá a jóváhagyási hivatkozást használó külső jóváhagyó által opcionálisan megadott név és megjegyzés.\n• Audit- és biztonsági naplók: a fontosabb műveletek (például bejelentkezés, közzététel, jogosultságmódosítás) nyilvántartása a kapcsolódó technikai adatokkal, például időbélyegekkel.\n• MI-funkciók adatai: ha a Felhasználó használja a mesterséges intelligencián alapuló szövegíró funkciókat, az általa megadott utasítások (promptok) és a létrehozott szövegek.\n• E-mail-kézbesítési naplók: a Felhasználónak küldött tranzakciós e-mailek (például meghívók, jóváhagyási kérések, értesítések) és kézbesítési állapotuk nyilvántartása.\n• A Metától (Facebook és Instagram) kapott adatok a 4. pontban leírtak szerint.",

  "privacy.s4.title": "4. A Metától (Facebook és Instagram) kapott adatok",
  "privacy.s4.body":
    "Amikor egy arra jogosult Felhasználó a Facebook Login for Business segítségével Facebook-oldalt vagy Instagram szakmai fiókot csatlakoztat, a Szolgáltatás a Felhasználó által megadott engedélyek keretein belül az alábbi adatokat kapja meg a Metától:\n• felhasználói hozzáférési token (amelyet a Szolgáltatás hosszú élettartamú tokenre cserél) és oldal-hozzáférési tokenek;\n• az oldal azonosítója, neve és profilképe;\n• a csatlakoztatott Instagram szakmai fiók azonosítója, felhasználóneve és profilképe;\n• a Szolgáltatáson keresztül közzétett bejegyzések azonosítói;\n• a csatlakoztatott oldalak, bejegyzések és Instagram-fiókok statisztikai adatai (insights), például elérés, megtekintések, megjelenések és interakciószámok (reakciók, hozzászólások, megosztások, mentések).\n\nAz adatok felhasználása:\n• A hozzáférési tokeneket az Adatkezelő AES-256-GCM titkosítással tárolja, azok egyetlen Felhasználó számára sem jelennek meg, és kizárólag az Ügynökség és/vagy az ügyfél által jóváhagyott tartalmak közzétételére, valamint a csatlakoztatott fiókok statisztikai adatainak lekérdezésére szolgálnak.\n• Az oldal- és fiókadatok azt mutatják meg, mely fiókok vannak csatlakoztatva, és lehetővé teszik, hogy a Felhasználó kiválassza, hol jelenjen meg egy bejegyzés.\n• A statisztikai adatok a Szolgáltatás Analitika menüpontjában jelennek meg az Ügynökség és az érintett ügyfél számára.\n\nAmit az Adatkezelő nem tesz:\n• Adatot nem értékesít, és a Metától kapott adatokat nem használja hirdetési célra.\n• Nem készít profilt azokról a személyekről, akik a csatlakoztatott oldalakkal vagy fiókokkal interakcióba lépnek.\n• A Szolgáltatás nem olvassa a privát üzeneteket, és nem gyűjti azoknak a személyeknek az adatait, akik a csatlakoztatott oldalakon vagy fiókokon hozzászólnak, reagálnak vagy más módon interakcióba lépnek.\n• A Metától kapott adatokat kizárólag a Meta Platform Terms és a fejlesztői irányelvek (Developer Policies) szerint használja.",

  "privacy.s5.title": "5. Az adatkezelés céljai és jogalapjai",
  "privacy.s5.body":
    "Az Adatkezelő a személyes adatokat az Európai Unió általános adatvédelmi rendelete (GDPR) alapján az alábbi célokból és jogalapokon kezeli:\n• A Szolgáltatás nyújtása (fiókok, munkaterületek, tartalomtervezés, jóváhagyás, közzététel, elemzések): az Ügynökség és ügyfele közötti szerződés teljesítése, illetve az Ügynökségnek a vállalt szolgáltatások nyújtásához fűződő jogos érdeke (GDPR 6. cikk (1) bekezdés b) és f) pont).\n• Külső jóváhagyók hivatkozáson keresztüli jóváhagyása: az Ügynökség és ügyfele jogos érdeke a tartalom-jóváhagyás dokumentálásához (6. cikk (1) bekezdés f) pont).\n• Biztonság, auditnaplózás és visszaélések megelőzése: a Szolgáltatás és a csatlakoztatott fiókok biztonságához fűződő jogos érdek (6. cikk (1) bekezdés f) pont).\n• MI-alapú szövegíró funkciók: szerződés teljesítése, illetve jogos érdek, kizárólag akkor, ha a Felhasználó e funkciókat használja (6. cikk (1) bekezdés b) és f) pont).\n• Tranzakciós e-mailek: szerződés teljesítése, illetve a jóváhagyási folyamat működtetéséhez fűződő jogos érdek (6. cikk (1) bekezdés b) és f) pont).\n• Jogi kötelezettségek teljesítése, például számviteli kötelezettségek vagy hatósági megkeresések (6. cikk (1) bekezdés c) pont).\n\nA jogos érdeken alapuló adatkezelés ellen az érintett a 10. pontban leírtak szerint tiltakozhat.",

  "privacy.s6.title": "6. Adatfeldolgozók és címzettek",
  "privacy.s6.body":
    "A Szolgáltatás működtetéséhez az Adatkezelő az alábbi szolgáltatókat (adatfeldolgozókat) veszi igénybe:\n• Vercel – a webalkalmazás tárhelye (frankfurti, németországi régió).\n• Railway – PostgreSQL-adatbázis, Redis-alapú feladatsor és háttérfolyamat (EU West régió).\n• Cloudflare (R2) – a feltöltött médiafájlok tárolása.\n• Resend – tranzakciós e-mailek küldése (EU-s régió).\n• OpenAI – MI-alapú szöveggenerálás, kizárólag akkor, ha a Felhasználó használja az MI-funkciókat.\n\nA Meta Platforms (Facebook és Instagram) megkapja a csatlakoztatott fiókokon közzétett tartalmakat, és azokat saját feltételei és adatkezelési szabályzata szerint, önálló adatkezelőként kezeli.\n\nA Szolgáltatáson belül az adatokhoz csak azok a Felhasználók férnek hozzá, akik szerepkörüknek megfelelően hozzáféréssel rendelkeznek az adott szervezethez vagy ügyfél-munkaterülethez. Az Adatkezelő személyes adatot nem értékesít, és harmadik feleknek azok saját marketingcéljaira nem ad át.",

  "privacy.s7.title": "7. Harmadik országba történő adattovábbítás",
  "privacy.s7.body":
    "Egyes szolgáltatók az Amerikai Egyesült Államokban vagy más, az Európai Gazdasági Térségen (EGT) kívüli országban működnek, illetve onnan férhetnek hozzá az adatokhoz. Ha személyes adat az EGT-n kívülre kerül, a továbbítás az Európai Bizottság megfelelőségi határozatán (például – tanúsított szolgáltató esetén – az EU–USA adatvédelmi keretrendszeren) vagy az Európai Bizottság által elfogadott általános szerződési feltételeken (standard contractual clauses) alapul, szükség esetén kiegészítő garanciákkal.",

  "privacy.s8.title": "8. Az adatok megőrzése",
  "privacy.s8.body":
    "Az Adatkezelő a személyes adatokat csak a fenti célokhoz szükséges ideig őrzi meg:\n• A fiókadatokat a fiók fennállásáig. A fiók törlése 24 órás türelmi idő után indul, ezt követően a személyes adatok törlésre kerülnek.\n• A szervezeti adatokat a szervezet fennállásáig. A szervezet törlése 72 órás türelmi idő után indul, és eltávolítja a szervezet rekordjait és tárolt médiafájljait.\n• Minden szervezet beállíthat adatmegőrzési időt (napokban). Ennek leteltével a régebbi működési nyilvántartások – jóváhagyások, háttérfeladatok, webhook-események, értesítések, metrikák, MI-generálások, meghívók, ideiglenesen törölt médiafájlok és bejegyzések, valamint auditnaplók – automatikusan törlődnek.\n• A Meta hozzáférési tokenek törlődnek a fiók leválasztásakor, az alkalmazás Facebook-beállításokban történő eltávolításakor, illetve a szervezet törlésekor.\n• A jogszabály által előírt adatokat (például számviteli bizonylatokat) az Adatkezelő a jogszabályban meghatározott ideig őrzi meg.",

  "privacy.s9.title": "9. Adatbiztonság",
  "privacy.s9.body":
    "Az Adatkezelő megfelelő technikai és szervezési intézkedésekkel védi a személyes adatokat, így különösen:\n• titkosított (TLS) kapcsolattal minden adatforgalom esetén;\n• a közösségi platformok hozzáférési tokenjeinek titkosított (AES-256-GCM) tárolásával;\n• ügyfél-munkaterületenként elkülönített, szerepkör-alapú hozzáférés-szabályozással;\n• a fontosabb műveletek auditnaplózásával;\n• kéréskorlátozással (rate limiting) és a visszaélések elleni egyéb intézkedésekkel.",

  "privacy.s10.title": "10. Az érintettek jogai",
  "privacy.s10.body":
    "A GDPR alapján az érintett jogosult:\n• tájékoztatást kérni a személyes adatai kezeléséről, és másolatot kapni azokról (hozzáférési jog);\n• kérni a pontatlan adatok helyesbítését;\n• kérni az adatai törlését;\n• kérni az adatkezelés korlátozását;\n• az adathordozhatóságra – a bejelentkezett Felhasználó a Beállítások → Adatvédelem és adatmegőrzés menüpontban JSON formátumban letöltheti az adatait;\n• tiltakozni a jogos érdeken alapuló adatkezelés ellen.\n\nA jogok gyakorlására irányuló kérelmek az info@g2amarketing.hu címre küldhetők. Az Adatkezelő a kérelmet indokolatlan késedelem nélkül, de legfeljebb egy hónapon belül bírálja el.\n\nHa az érintett úgy ítéli meg, hogy személyes adatainak kezelése jogsértő, panaszt tehet a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH; honlap: naih.hu) vagy a lakóhelye szerinti felügyeleti hatóságnál, továbbá bírósághoz fordulhat.",

  "privacy.s11.title": "11. Az adatok törlése",
  "privacy.s11.body":
    "A Felhasználó leválaszthatja Facebook- és Instagram-fiókjait, eltávolíthatja az alkalmazást a Facebook-beállításaiban, törölheti a fiókját, vagy e-mailben kérheti adatai törlését. A lépésenkénti útmutató az Adattörlési útmutató oldalon (/legal/deletion) érhető el.",

  "privacy.s12.title": "12. Sütik (cookie-k)",
  "privacy.s12.body":
    "A Szolgáltatás kizárólag a működéséhez szükséges sütiket használja: egy munkamenet-sütit a bejelentkezés fenntartásához, valamint egy sütit a kiválasztott felületi nyelv tárolásához. Hirdetési vagy harmadik féltől származó követő sütiket a Szolgáltatás nem használ.",

  "privacy.s13.title": "13. A tájékoztató módosítása",
  "privacy.s13.body":
    "Az Adatkezelő a tájékoztatót a Szolgáltatás vagy a jogszabályok változása esetén módosíthatja. A legutóbbi módosítás dátuma az oldal tetején látható. A lényeges változásokról az Adatkezelő a Szolgáltatásban vagy e-mailben tájékoztatja a Felhasználókat.",

  // ------------------------------------------------------------------ Terms
  "terms.s1.title": "1. A Szolgáltató és a feltételek hatálya",
  "terms.s1.body":
    "A G2A Social Hub szolgáltatást (a továbbiakban: Szolgáltatás) a G2A Marketing Bt. (székhely: [székhely]; cégjegyzékszám: [cégjegyzékszám]; adószám: [adószám]; e-mail: info@g2amarketing.hu; telefon: +36 30 190 2575) (a továbbiakban: Szolgáltató) üzemelteti.\n\nE Felhasználási feltételek a Szolgáltatás használatát szabályozzák. A Szolgáltatást a Szolgáltató az ügynökségi munkatársai és ügyfelei részére, a Szolgáltató és az ügyfél között létrejött külön szolgáltatási szerződéshez kapcsolódóan nyújtja. Ha e feltételek és a szerződés között eltérés van, a szerződés rendelkezései az irányadók.",

  "terms.s2.title": "2. Fiókok és hozzáférés",
  "terms.s2.body":
    "• A Szolgáltatáshoz kizárólag meghívással lehet hozzáférni. A Felhasználó köteles valós adatokat megadni, és bejelentkezési adatait bizalmasan kezelni.\n• Minden Felhasználó a számára kiosztott szerepkör (például tulajdonos, adminisztrátor, social manager, tartalomkészítő, megtekintő vagy ügyféloldali jóváhagyó) keretein belül jár el.\n• A külső jóváhagyóknak küldött jóváhagyási hivatkozások személyre szólnak, azokat jogosulatlan személynek továbbítani tilos.\n• Ha a Felhasználó fiókjához való jogosulatlan hozzáférést észlel vagy gyanít, köteles erről a Szolgáltatót haladéktalanul értesíteni az info@g2amarketing.hu címen.",

  "terms.s3.title": "3. Közösségimédia-fiókok csatlakoztatása",
  "terms.s3.body":
    "Facebook-oldalt és Instagram szakmai fiókot csak az a Felhasználó csatlakoztathat, aki jogosult az adott fiók kezelésére. A fiók csatlakoztatásával a Felhasználó felhatalmazza a Szolgáltatást arra, hogy a Szolgáltatásban jóváhagyott tartalmakat a fiókon közzétegye, és lekérdezze a fiók statisztikai adatait. A kapcsolat bármikor megszüntethető a Csatlakoztatott fiókok menüpontban vagy a Facebook-beállításokban.",

  "terms.s4.title": "4. Elfogadható használat",
  "terms.s4.body":
    "A Szolgáltatás nem használható:\n• a Meta Platform Terms, a Facebook Közösségi alapelvek, az Instagram Közösségi irányelvek vagy bármely más csatlakoztatott platform feltételeinek megsértésével;\n• jogellenes, jogsértő, megtévesztő, rágalmazó, gyűlöletkeltő vagy más módon káros tartalom közzétételére;\n• kéretlen üzenetek (spam) küldésére vagy a platformok által nem engedélyezett automatizált tevékenységre;\n• olyan adatokhoz, munkaterületekhez vagy fiókokhoz való hozzáférés megkísérlésére, amelyekhez a Felhasználó nem jogosult, illetve a Szolgáltatás biztonságának vagy működésének megzavarására.",

  "terms.s5.title": "5. Tartalmak és felelősség",
  "terms.s5.body":
    "A feltöltött tartalmak a Felhasználók, illetve az ügyfelek tulajdonában maradnak. A Felhasználó, illetve az ügyfél a Szolgáltatónak megadja a tartalmak tárolásához, feldolgozásához és közzétételéhez szükséges jogokat, kizárólag a Szolgáltatás nyújtásának céljára.\n\nA bejegyzés tartalmáért az a Felhasználó, illetve ügyfél felel, aki azt jóváhagyja vagy közzéteszi, ideértve azt is, hogy a tartalom megfelel a jogszabályoknak, és a szükséges jogok (például szerzői és képmáshoz fűződő jogok) rendelkezésre állnak.",

  "terms.s6.title": "6. MI-funkciók",
  "terms.s6.body":
    "A Szolgáltatás mesterséges intelligencián alapuló szövegjavaslatokat kínálhat. Az MI által létrehozott szövegek kizárólag javaslatok, pontatlanok vagy nem megfelelők lehetnek, ezért közzététel előtt azokat személyesen ellenőrizni kell. Az utasítások (promptok) csak akkor kerülnek továbbításra az MI-szolgáltatóhoz, ha a Felhasználó e funkciókat használja.",

  "terms.s7.title": "7. Rendelkezésre állás",
  "terms.s7.body":
    "A Szolgáltatás folyamatos fejlesztés alatt áll. A teszt-, staging- és béta-változatokat a Szolgáltató „adott állapotban” és „a rendelkezésre állás függvényében” nyújtja, a megszakításmentes vagy hibamentes működés garantálása nélkül. A közzététel a közösségi platformok elérhetőségétől is függ, amely a Szolgáltató befolyásán kívül esik. Az esetleges szolgáltatási szinteket a külön szolgáltatási szerződés tartalmazza.",

  "terms.s8.title": "8. A felelősség korlátozása",
  "terms.s8.body":
    "Az alkalmazandó jog által megengedett mértékben a Szolgáltató nem felel a közvetett vagy következményi károkért, az elmaradt haszonért és az adatvesztésért, sem a közösségi platformok működéséből, döntéseiből vagy kieséséből eredő károkért. E korlátozás nem vonatkozik arra a felelősségre, amely kógens jogszabály alapján nem zárható ki és nem korlátozható, így különösen a szándékosan vagy súlyos gondatlansággal okozott, illetve az emberi életet, testi épséget vagy egészséget megkárosító szerződésszegésért való felelősségre.",

  "terms.s9.title": "9. Felfüggesztés és megszüntetés",
  "terms.s9.body":
    "A Szolgáltató felfüggesztheti vagy megszüntetheti a Felhasználó hozzáférését, ha a Felhasználó megszegi e feltételeket, vagy ha ezt jogszabály vagy valamely platform előírja. A hozzáférés a Szolgáltató és az ügyfél közötti szerződés megszűnésével is megszűnik. A Felhasználó fiókját bármikor törölheti a Beállítások → Adatvédelem és adatmegőrzés menüpontban. Az adatok törlésére az Adatkezelési tájékoztató és az Adattörlési útmutató az irányadó.",

  "terms.s10.title": "10. Adatvédelem",
  "terms.s10.body":
    "A személyes adatok Szolgáltatáson belüli kezelését az Adatkezelési tájékoztató (/legal/privacy) írja le.",

  "terms.s11.title": "11. A feltételek módosítása",
  "terms.s11.body":
    "A Szolgáltató jogosult e feltételeket módosítani. A lényeges változásokról a Felhasználókat előzetesen, a Szolgáltatásban vagy e-mailben tájékoztatja. A módosítás hatálybalépését követő további használat a módosított feltételek elfogadásának minősül.",

  "terms.s12.title": "12. Irányadó jog és kapcsolat",
  "terms.s12.body":
    "E feltételekre a magyar jog az irányadó. A jogviták elbírálására a magyar jog szerint hatáskörrel és illetékességgel rendelkező bíróság jogosult. A feltételekkel kapcsolatos kérdések az info@g2amarketing.hu címre küldhetők.",

  // --------------------------------------------------------------- Deletion
  "deletion.s1.title": "Áttekintés",
  "deletion.s1.body":
    "Ez az oldal bemutatja, hogyan törölhetők azok az adatok, amelyeket a G2A Social Hub (üzemeltető: G2A Marketing Bt.) a Felhasználóról, illetve a Felhasználó Facebook- és Instagram-fiókjairól tárol. Az alábbi lehetőségek bármelyike választható.",

  "deletion.s2.title": "1. Fiók leválasztása a G2A Social Hubban",
  "deletion.s2.body":
    "• Jelentkezzen be, és nyissa meg a Csatlakoztatott fiókok menüpontot.\n• Válassza a Leválasztás lehetőséget az adott Facebook-oldal vagy Instagram-fiók mellett.\n\nEzzel az alkalmazás engedélyei a Metánál visszavonásra kerülnek, a tárolt hozzáférési tokenek pedig törlődnek. Az adott fiókra ütemezett bejegyzések ezt követően nem jelennek meg.",

  "deletion.s3.title":
    "2. Az alkalmazás eltávolítása a Facebook-beállításokban",
  "deletion.s3.body":
    "• A Facebookon nyissa meg a Beállítások és adatvédelem → Beállítások menüpontot.\n• Válassza az Üzleti integrációk (vagy Alkalmazások és webhelyek) lehetőséget.\n• Jelölje ki a G2A Social Hub alkalmazást, és válassza az Eltávolítás lehetőséget.\n\nA Meta erről az adattörlési visszahívási végponton (data deletion callback) keresztül automatikusan értesíti az Adatkezelőt, amely törli a tárolt hozzáférési tokeneket, és leválasztja az érintett fiókokat. A Meta egy megerősítő kódot és egy hivatkozást jelenít meg a webhely állapotoldalára (/meta/deletion/<kód>), ahol a kérelem állapota ellenőrizhető.",

  "deletion.s4.title": "3. A G2A Social Hub-fiók törlése",
  "deletion.s4.body":
    "A bejelentkezett Felhasználó a Beállítások → Adatvédelem és adatmegőrzés menüpontban letöltheti személyes adatait (JSON-export), és kérheti fiókja törlését. A fiók törlése 24 órás türelmi idő után indul, és a feldolgozás előtt visszavonható. Ha a Felhasználó egy szervezet egyedüli tulajdonosa, előbb át kell adnia a tulajdonjogot, vagy törölnie kell a szervezetet.",

  "deletion.s5.title": "4. Szervezet törlése",
  "deletion.s5.body":
    "A szervezet tulajdonosai ugyanezen a képernyőn kérhetik a szervezet törlését. Ehhez előbb a csatlakoztatott közösségimédia-fiókokat le kell választani. A szervezet törlése 72 órás türelmi idő után indul, eltávolítja a szervezet rekordjait és tárolt médiafájljait, és a feldolgozás előtt visszavonható.",

  "deletion.s6.title": "5. Törlési kérelem e-mailben",
  "deletion.s6.body":
    "Az adatok törlése e-mailben is kérhető az info@g2amarketing.hu címen. A kérelemben kérjük megadni a fiókhoz tartozó e-mail-címet vagy az érintett Facebook-oldal, illetve Instagram-fiók nevét. Az Adatkezelő a személyazonosság igazolását kérheti, és legfeljebb egy hónapon belül válaszol.\n\nA jogszabály alapján megőrzendő adatok a kötelező megőrzési idő leteltével törlődnek. További információ az Adatkezelési tájékoztatóban (/legal/privacy) olvasható.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
