# Meta App Review – felkészülési útmutató (G2A Social Hub)

Ez a dokumentum a G2A Social Hub Meta-alkalmazásának App Review-beadásához készült. A Meta felületének gombjait, menüpontjait és az engedélyek nevét angolul hagytuk, mert a Developer Dashboard és a beadási űrlap is angol.

> A jogi oldalak (`/legal/privacy`, `/legal/terms`, `/legal/deletion`) **tervezetek**; éles indulás előtt jogi ellenőrzés szükséges. Az oldalak tetején látható „Draft / Tervezet” figyelmeztetés a beadáskor is maradhat.

---

## 1. Cégadatok

A jogi szövegekben (`apps/web/i18n/messages/legal.ts`, HU és EN) szereplő adatok a cégnyilvántartás szerint:

- G2A Marketing Szolgáltató Betéti Társaság (G2A Marketing Bt.)
- Székhely: 7625 Pécs, Péter utca 1. földszint 1.
- Cégjegyzékszám: Cg. 02-06-075160 (Pécsi Törvényszék Cégbírósága)
- Adószám: 32070325-1-02

Ebben a dokumentumban még:

- `hub.g2amarketing.hu` – az éles (production) domain: `hub.g2amarketing.hu`. A staging (`socialhub-staging.vercel.app`) csak tesztelésre szolgál; a beadáskor minden URL az éles domainre mutasson.

## 2. Teendők a Meta App Dashboardon

1. **Business verification** – a G2A Marketing Bt. üzleti ellenőrzése a Meta Business Managerben (Security Center → Business verification). Advanced Access-hez kötelező.
2. **App settings → Basic**
   - **App icon**: 1024×1024 px, PNG/JPG.
   - **Privacy Policy URL**: `https://hub.g2amarketing.hu/legal/privacy`.
   - **Terms of Service URL**: `https://hub.g2amarketing.hu/legal/terms`.
   - **User data deletion**: válaszd a **Data deletion callback URL** opciót → `https://hub.g2amarketing.hu/api/meta/data-deletion`. (Az emberi olvasásra szánt útmutató: `https://hub.g2amarketing.hu/legal/deletion` – ezt az adatkezelési tájékoztató is linkeli.)
   - **Category**: Business and pages (vagy a legközelebbi elérhető „Business” kategória).
   - **Contact email**: `info@g2amarketing.hu`.
3. **Facebook Login for Business → Settings**
   - **Valid OAuth Redirect URIs**: `https://hub.g2amarketing.hu/api/oauth/meta/callback` (a staging domainnel is).
   - **Deauthorize callback URL**: `https://hub.g2amarketing.hu/api/meta/deauthorize`.
   - **Data Deletion Request URL** (ha itt is kéri): `https://hub.g2amarketing.hu/api/meta/data-deletion`.
4. **Facebook Login for Business → Configurations** – a konfiguráció (`META_LOGIN_CONFIG_ID`) pontosan a 3. pontban felsorolt tizenkét engedélyt tartalmazza, ne többet. A meglévő kapcsolatokat az új engedélyek miatt újra kell csatlakoztatni (Connected accounts → Connect Facebook & Instagram).
4/b. **Webhooks** (App Dashboard → Webhooks, vagy a Használati esetek alatt):
   - **Callback URL**: `https://hub.g2amarketing.hu/api/webhooks/meta`, **Verify token**: a `META_WEBHOOK_VERIFY_TOKEN` környezeti változó értéke (a Vercel env-ben; ne írd ide).
   - **Page** objektum: iratkozz fel a `feed` mezőre.
   - **Instagram** objektum: iratkozz fel a `comments` mezőre.
   - Az oldalak feliratkozását (`/{page-id}/subscribed_apps`) az alkalmazás magától elvégzi az első kommentszinkronnál, ha a kapcsolat már tartalmazza a `pages_manage_metadata` engedélyt.
   - Fejlesztői módban a Meta csak az app szerepkörrel rendelkező felhasználók eseményeit küldi; addig a kommentek a 10 percenkénti lekérdezéssel érkeznek.
5. **Data Use Checkup** – évente kötelező; a beadás előtt erősítsd meg, hogy az adatokat csak a leírt célra használjuk.
6. **App Review → Permissions and features** – minden kért engedélyhez: leírás (lásd 3. pont), screencast (lásd 4. pont), és a „Request advanced access” gomb.
7. Ellenőrizd, hogy a fenti URL-ek bejelentkezés nélkül, 200-as válasszal betöltenek (a Meta botja ellenőrzi).

## 3. Kért engedélyek

A beadás a közzététel és az analitika nyolc engedélye mellett a **Kommentek** funkcióhoz szükséges négy engedélyt is tartalmazza (`pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `instagram_manage_comments`). Üzenetkezelési engedélyt (`pages_messaging`, `instagram_manage_messages`) **nem** kérünk: privát üzeneteket az alkalmazás nem kezel.

### Áttekintő táblázat

| Engedély | Mire használjuk | Melyik képernyőn látszik |
|---|---|---|
| `pages_show_list` | A felhasználó által kezelt Facebook-oldalak listázása, hogy kiválaszthassa, melyiket csatlakoztatja | Connected accounts → Connect Facebook & Instagram (oldalválasztás), majd a csatlakoztatott fiókok listája |
| `business_management` | A Business Managerben (Business Portfolio) tulajdonolt oldalak és Instagram-fiókok elérése Facebook Login for Business-szel | Connected accounts (csatlakoztatás) |
| `pages_read_engagement` | Oldal-adatok (név, kép, kapcsolt IG-fiók) és a közzétett bejegyzések interakcióinak olvasása | Connected accounts, Posts (közzétett bejegyzés állapota), Analytics |
| `pages_manage_posts` | Jóváhagyott bejegyzések (szöveg + kép/videó) közzététele a Facebook-oldalon | Create → Publish now / ütemezés, Posts |
| `read_insights` | Oldal- és bejegyzésszintű statisztikák (elérés, megtekintések, interakciók) olvasása | Analytics |
| `instagram_basic` | A kapcsolt Instagram szakmai fiók azonosítója, felhasználóneve, profilképe | Connected accounts |
| `instagram_content_publish` | Jóváhagyott bejegyzések közzététele az Instagram szakmai fiókon | Create → Publish now / ütemezés, Posts |
| `instagram_manage_insights` | Instagram fiók- és bejegyzés-statisztikák olvasása | Analytics |
| `pages_read_user_content` | A közzétett bejegyzések alatti hozzászólások (szöveg, szerző neve) olvasása | Comments |
| `pages_manage_engagement` | Válasz a Facebook-hozzászólásokra az oldal nevében, nem megfelelő hozzászólás elrejtése | Comments → Reply / Hide |
| `pages_manage_metadata` | Az oldal feliratkoztatása az alkalmazás webhookjaira, hogy az új hozzászólások azonnal megérkezzenek | Comments (háttérben) |
| `instagram_manage_comments` | Instagram-hozzászólások olvasása, megválaszolása és elrejtése | Comments → Reply / Hide |

### Beillesztendő angol szövegek („How will your app use this permission?”) + magyar magyarázat

**pages_show_list**

> G2A Social Hub is a social media management tool used by our agency (G2A Marketing) and its business clients to plan, approve and publish posts on the clients' Facebook Pages. After the agency administrator signs in with Facebook Login for Business, we use pages_show_list to display the Pages they manage, so they can choose which Page to connect to a client workspace. The list is shown on the "Connected accounts" screen. Without this permission the user cannot select the Page they want to publish to.

HU: Az oldalválasztáshoz kell – ezzel listázzuk a felhasználó által kezelt Facebook-oldalakat a csatlakoztatáskor.

**business_management**

> Our agency's clients' Pages and Instagram accounts are owned by Business Portfolios (Business Manager). We use business_management, together with Facebook Login for Business, to access the Pages and connected Instagram professional accounts that the business has assigned to the user, so they can be connected on the "Connected accounts" screen. We do not create, modify or delete any business assets, ad accounts or users.

HU: Business Portfolióban lévő oldalakhoz/IG-fiókokhoz való hozzáféréshez kell a Login for Business folyamatban. Üzleti eszközöket nem módosítunk.

**pages_read_engagement**

> We use pages_read_engagement to read basic Page information (name, profile picture, linked Instagram professional account) shown on the "Connected accounts" screen, and to read engagement data (reactions, comments count, shares) of posts that were published through G2A Social Hub. These numbers are shown to the agency and the client on the "Posts" and "Analytics" screens so they can see how their approved content performed. We do not read or store the content or identity of people who comment or react.

HU: Az oldal alapadatainak és a nálunk közzétett bejegyzések interakciószámainak olvasásához kell (Posts, Analytics). Hozzászólók személyes adatait nem olvassuk.

**pages_manage_posts**

> The core function of G2A Social Hub is publishing content that a client has approved. A content creator writes a post with an image or video, the client approves it, and then the post is published to the client's Facebook Page either immediately ("Publish now") or at the scheduled time. We use pages_manage_posts only to create these approved posts on the connected Page. Nothing is published without an explicit user action and approval.

HU: Ez a fő funkció: a jóváhagyott bejegyzés közzététele a Facebook-oldalon (azonnal vagy ütemezve). Jóváhagyás és felhasználói művelet nélkül semmi nem jelenik meg.

**read_insights**

> We use read_insights to read Page-level and post-level insights (reach, views/impressions and engagement metrics) for the connected Pages. These metrics are displayed on the "Analytics" screen so the agency and its client can measure the performance of the published content and plan future posts. Insights are only shown to users who have access to that client's workspace and are never sold or used for advertising.

HU: Az Analytics oldal statisztikáihoz kell (elérés, megtekintés, interakció), csak az adott ügyfél-munkaterület tagjainak látható.

**instagram_basic**

> We use instagram_basic to read the ID, username and profile picture of the Instagram professional account linked to the connected Facebook Page. This is shown on the "Connected accounts" screen so the user can confirm the correct Instagram account is connected, and the account ID is needed to publish approved content and read its insights.

HU: Az IG szakmai fiók azonosítójához, felhasználónevéhez és profilképéhez kell (Connected accounts), az azonosító a közzétételhez és a statisztikákhoz is szükséges.

**instagram_content_publish**

> We use instagram_content_publish to publish client-approved posts (image or video with caption) to the client's Instagram professional account, either immediately ("Publish now") or at the scheduled time. A post is only published after it has been created in G2A Social Hub, approved by the client and published or scheduled by an authorized agency user.

HU: A jóváhagyott bejegyzés közzétételéhez kell az Instagram szakmai fiókon.

**instagram_manage_insights**

> We use instagram_manage_insights to read account-level and media-level insights (reach, views and engagement counts) for the connected Instagram professional account. The metrics are shown on the "Analytics" screen to the agency and the client to evaluate the performance of the published content. We do not collect data about individual Instagram users.

HU: Az Instagram-statisztikák (elérés, megtekintés, interakció) Analytics oldalon való megjelenítéséhez kell.

**pages_read_user_content**

> G2A Social Hub has a "Comments" inbox where the agency's community managers see the comments left under the posts of the client's Facebook Page. We use pages_read_user_content to read these comments (text, time and the commenter's name as returned by the API) so they can be answered from one place. Comments are shown only to members of that client's workspace, are not combined with other data, are not used for advertising or profiling, and are deleted according to the workspace's data retention setting.

HU: A Kommentek oldalhoz kell: a Facebook-oldal bejegyzései alatti hozzászólások olvasása. Csak az ügyfél-munkaterület tagjai látják, hirdetésre/profilozásra nem használjuk.

**pages_manage_engagement**

> In the "Comments" inbox an authorized community manager can reply to a comment on behalf of the client's Page, or hide an abusive or spam comment. We use pages_manage_engagement only to post these replies and to hide/unhide comments, and only when a user explicitly clicks "Reply" or "Hide". Nothing is posted automatically.

HU: A Kommentek oldalon a válaszadáshoz (az oldal nevében) és a nem megfelelő hozzászólás elrejtéséhez kell; csak felhasználói kattintásra történik.

**pages_manage_metadata**

> We use pages_manage_metadata to subscribe the connected Page to our app's webhooks (feed field), so that new comments appear in the "Comments" inbox within seconds instead of waiting for periodic polling. We do not change any other Page settings.

HU: Az oldal webhook-feliratkozásához kell (feed mező), hogy az új hozzászólások azonnal megjelenjenek. Más oldalbeállítást nem módosítunk.

**instagram_manage_comments**

> We use instagram_manage_comments to read the comments on media published by the client's Instagram professional account, to post replies on behalf of the account, and to hide inappropriate comments, all from the "Comments" inbox and only on explicit user action. We also receive the account's comment webhooks for this inbox.

HU: Az Instagram-hozzászólások olvasásához, megválaszolásához és elrejtéséhez kell a Kommentek oldalon, csak felhasználói műveletre.

## 4. Screencast-forgatókönyv

Általános szabályok:

- **A felület legyen angol nyelvű.** Az alkalmazás kétnyelvű: felvétel előtt **Settings → Language** (Beállítások → Nyelv) alatt állítsd a felület nyelvét **English**-re. A Facebook felülete is legyen angol, ha lehet.
- Böngésző címsor látszódjon (staging URL), felbontás legalább 1280×720, felesleges fülek bezárva.
- Minden engedélyhez feltölthető ugyanaz a teljes videó, de a leírásban add meg, melyik időpontnál látszik az adott engedély (pl. „0:45 – pages_manage_posts”). Alternatíva: engedélyenként rövid, vágott klip.
- Jelszó vagy token ne kerüljön képernyőre (a bejelentkezést lehet vágni vagy jelszómezőt takarni).

### A) Teljes folyamat (minden engedély)

1. Nyisd meg a staging URL-t, jelentkezz be a **reviewer teszt-felhasználóval** (lásd 5. pont).
2. Mutasd meg: Settings → Language = English (ha még nem az).
3. Válaszd ki a teszt ügyfél-munkaterületet, majd nyisd meg a **Connected accounts** menüpontot.
4. Kattints a **Connect Facebook & Instagram** gombra → megjelenik a Facebook Login for Business ablak.
5. A Meta párbeszédablakban válaszd ki a **teszt Facebook-oldalt** és a hozzá kapcsolt **Instagram szakmai fiókot**; mutasd meg a kért engedélyeket, majd fogadd el. *(pages_show_list, business_management)*
6. Vissza az alkalmazásban: a Connected accounts listán megjelenik az oldal neve, képe és az IG felhasználónév. *(pages_read_engagement, instagram_basic)*
7. **Create**: írj egy bejegyzést, tölts fel egy képet, válaszd ki célnak a Facebook-oldalt és az Instagram-fiókot.
8. **Send for approval** → mutasd meg a jóváhagyási folyamatot (Approvals menüpont vagy az ügyfélnek küldött jóváhagyási link), és hagyd jóvá a bejegyzést.
9. Kattints a **Publish now** gombra; várd meg, amíg a státusz „published” lesz. *(pages_manage_posts, instagram_content_publish)*
10. Nyisd meg új fülön a Facebook-oldalt és az Instagram-profilt, mutasd meg a megjelent bejegyzést.
11. Vissza az alkalmazásba: **Analytics** – mutasd meg az oldal-, bejegyzés- és Instagram-statisztikákat (elérés, megtekintés, interakciók). *(read_insights, instagram_manage_insights, pages_read_engagement)*
11/b. Írj egy hozzászólást (egy másik, app szerepkörrel rendelkező Facebook-/Instagram-fiókból) a most közzétett bejegyzés alá. Az alkalmazásban nyisd meg a **Comments** menüpontot: mutasd meg, hogy a hozzászólás megjelent (szükség esetén **Refresh**). *(pages_read_user_content, instagram_manage_comments, pages_manage_metadata)*
11/c. Írj választ, és kattints a **Reply** gombra; nyisd meg a Facebook-bejegyzést és az Instagram-tartalmat, és mutasd meg, hogy a válasz megjelent az oldal/fiók nevében. Ezután egy hozzászólásnál kattints a **Hide** gombra, és mutasd meg, hogy a Facebookon/Instagramon elrejtett állapotba került. *(pages_manage_engagement, instagram_manage_comments)*
12. **Connected accounts → Disconnect** (vagy Disconnect Meta grant) – mutasd meg, hogy a fiók leválasztásra került (ez visszavonja az engedélyeket és törli a tárolt tokeneket).
13. Opcionálisan: nyisd meg a `/legal/privacy` és `/legal/deletion` oldalt.

### B) Rövid klipek engedélyenként (ha a Meta külön kéri)

- **pages_show_list + business_management**: 3–6. lépés.
- **pages_manage_posts + instagram_content_publish**: 7–10. lépés.
- **read_insights + instagram_manage_insights + pages_read_engagement**: 6. és 11. lépés.
- **instagram_basic**: 6. lépés (IG felhasználónév és profilkép).
- **pages_read_user_content + pages_manage_metadata**: 11/b. lépés.
- **pages_manage_engagement + instagram_manage_comments**: 11/b–11/c. lépés.

## 5. Teszt-hozzáférés a reviewer számára

- Hozz létre egy külön **reviewer teszt-felhasználót** a staging környezetben (pl. admin vagy social manager szerepkörrel egy dedikált teszt ügyfél-munkaterületen). A jelszót **ne** írd ebbe a dokumentumba és ne commitold; csak az App Review űrlap „Testing instructions / test credentials” mezőjébe kerüljön.
- A teszt-munkaterülethez legyen elérhető egy **teszt Facebook-oldal** és egy hozzá kapcsolt **Instagram szakmai fiók**, amelyet a reviewer a saját Facebook-fiókjával nem tud elérni – ezért a Meta App Dashboardon (App roles → Test users / Roles) adj hozzáférést, vagy írd le a tesztelési utasításban, hogy a reviewer a már csatlakoztatott teszt-oldalon tudja kipróbálni a közzétételt és az analitikát.
- A tesztelési utasítás (angolul) írja le röviden a 4/A lépéseit, és hogy a felület nyelve a Settings → Language alatt állítható.
- A beadás után a reviewer fiókot hagyd aktívan, amíg a döntés meg nem születik; utána töröld vagy tiltsd le.

## 6. Ellenőrzőlista beadás előtt

- [ ] Jogi szövegek jogi ellenőrzése megtörtént (vagy tudatosan tervezetként adjuk be).
- [ ] `/legal/privacy`, `/legal/terms`, `/legal/deletion` publikusan, bejelentkezés nélkül elérhető.
- [ ] `/api/meta/data-deletion` és `/api/meta/deauthorize` élesítve, a Meta „Test” funkciójával kipróbálva; a `/meta/deletion/<code>` állapotoldal működik.
- [ ] Business verification kész.
- [ ] App icon, kategória, kapcsolattartó e-mail beállítva.
- [ ] Login for Business konfiguráció pontosan a 12 engedéllyel; a teszt-oldal újracsatlakoztatva az új engedélyekkel.
- [ ] Webhooks beállítva (Page: `feed`, Instagram: `comments`), a callback ellenőrzése sikeres.
- [ ] Screencast angol felülettel elkészült.
- [ ] Reviewer teszt-felhasználó létrehozva, adatai csak a beadási űrlapon.
- [ ] Data Use Checkup elvégezve.
