# G2A Social Hub – fejlesztési terv

Állapot: 2026-10-15 · Gazda: Győrfi Attila
Párterv: `GROWTH_ENGINE_TERV.md` (ugyanebben a mappában). Élő változat: https://claude.ai/code/artifact/7cf2686d-0844-4fc9-825e-a9811eb5307d

A Social Hub a G2A termékcsalád végrehajtó rétege: itt hagyják jóvá, ütemezik, publikálják és mérik a közösségi posztokat. A Growth Engine a tervező réteg, és vázlatokat küld ide. Publikálás, közösségi fiókkapcsolat és közösségi metrika csak itt létezik.

## Szerep és határvonal

Szabály: **közösségi platform és Meta = Social Hub; stratégia, Google- és webes adat = Growth Engine.** Ami a kettő között mozog, az az integrációs szerződésen keresztül megy, nem kódmásolással.

| Terület | Gazdája | A másik szoftver szerepe |
| --- | --- | --- |
| Közösségi fiókok csatlakoztatása (Meta, LinkedIn, később TikTok) | Social Hub | Nincs saját OAuth-ja ezekhez |
| Meta-alkalmazás és App Review | Social Hub (egyetlen app) | A Growth Engine Meta-appja megszűnik |
| Ütemezés, publikálás, újrapróbálás | Social Hub | Csak vázlatot küld |
| Jóváhagyás (belső + ügyfél) | Social Hub | Megkapja az eredményt webhookon |
| Márkaszabályok érvényesítése | Social Hub | Ő adja a forrást (márka-DNS, tiltott szavak) |
| Kommentek kezelése | Social Hub | – |
| Közösségi metrikák (organikus + Meta Ads) | Social Hub gyűjti | API-n lekéri a riportokhoz |
| Stratégia, cégelemzés, tartalompillérek | Growth Engine | Nem épít ilyet |
| Tartalomötletek, havi naptár generálása | Growth Engine | Vázlatként fogadja |
| GA4, Search Console, Google Ads adat | Growth Engine | – |
| Havi riport (.docx / PDF) | Growth Engine | Adatot szolgáltat |

A Social Hub önmagában is teljes termék: Growth Engine nélkül, kézzel írt posztokkal ugyanúgy működik.

## Hogyan épül egymásra a két szoftver

```
 Growth Engine – tervezés                          Social Hub – végrehajtás
 (stratégia, márka-DNS, havi naptár,   --- vázlatok · POST /drafts ------------>   (jóváhagyás belső + ügyfél,
  GA4/GSC/Ads, havi riport)            --- márkaprofil · PUT /brand-profile --->    ütemezés, publikálás,
                                       <-- jóváhagyás, publikálás · webhook ----    kommentek, márkaszabályok,
                                       <-- közösségi metrikák · GET /metrics ---    közösségi metrikák)
        |                                                                                  |
  Google: GA4 · GSC · Ads                                                    Meta · LinkedIn · TikTok
```

Egyetlen érintkezési pont: a Social Hub `/api/v1` API-ja. Egyik rendszer sem tárol a másik területéről tokent.

## Integrációs szerződés (v1)

A Social Hub verziózott, szervezetenkénti API-kulccsal védett API-t ad (`/api/v1`), és aláírt webhookokat küld. A Growth Engine ezt használja; ugyanezt egy külső ügyfél vagy a Claude havi naptár-automatizálása is használhatja. **Ugyanez a szerződés érvényes a Growth Engine-ben is – ha itt változik, ott is változni kell.**

**Ügyfél-párosítás.** Mindkét oldalon egy `external_ref` mező (pl. `mmi`, `viba-team`, `steba-nissan`) köti össze a Social Hub `client` és a Growth Engine `client_profile` rekordját. Nincs közös adatbázis.

| Végpont / esemény | Irány | Mire való |
| --- | --- | --- |
| `GET /api/v1/clients` | GE → SH | Ügyfelek és csatlakoztatott fiókok listája a párosításhoz |
| `POST /api/v1/clients/{id}/drafts` | GE → SH | Vázlatok tömeges feltöltése (szöveg, hálózatonkénti szöveg, javasolt időpont, média URL, pillér, forrás), `Idempotency-Key` fejléccel |
| `GET /api/v1/posts?client=&since=` | GE → SH | Posztok állapota (vázlat, jóváhagyásra vár, ütemezett, publikált, hibás) |
| `GET /api/v1/clients/{id}/metrics?from=&to=` | GE → SH | Napi fiók- és posztmetrikák normalizálva, a riportokhoz |
| `PUT /api/v1/clients/{id}/brand-profile` | GE → SH | Márkahang, kötelező/tiltott kifejezések, kötelező disclaimer, pillérek |
| `post.approved`, `post.changes_requested` | SH → GE | A jóváhagyás eredménye az AI-memóriának |
| `post.published`, `post.failed` | SH → GE | Naptárállapot és értesítés a Growth Engine-ben |

Szabályok:

- A Social Hub semmit nem publikál jóváhagyás nélkül, akkor sem, ha a vázlat a Growth Engine-ből jön.
- A márkaprofil gazdája a Growth Engine. A Social Hubban a szinkronizált mezők csak olvashatók, a helyi kiegészítések külön mezőben maradnak.
- A webhook HMAC-aláírást, eseményazonosítót és időbélyeget kap. A fogadó idempotensen dolgozza fel, a küldés a meglévő outbox-mintára épül.
- Törést okozó változás csak `/api/v2`-ben jöhet.

## Közös ütemterv

Egy fejlesztő, ezért egyszerre egy termék fázisa aktív (kivétel: az első hónap, amikor az SH F0 főleg Meta-várakozás).

| Időszak | Fázis |
| --- | --- |
| 2026. okt 15 – nov 15 | SH F0 · Éles Meta  ∥  GE G0 · Takarítás |
| 2026. nov 16 – dec 20 | **SH F1 · LinkedIn + API v1** (erre épül a GE G1 és G2) |
| 2027. jan 4 – jan 31 | GE G1 · Valós adat, riport |
| 2027. február | SH F2 · Ügynökségi mélység |
| 2027. március | GE G2 · Integráció és kivezetés |
| 2027. április | SH F3 · Portál, Meta Ads |
| 2027. május | GE G3 · Zárt kör |
| 2027. június | SH F4 · TikTok, pilot |

## Fejlesztési fázisok

Minden fázisnak van kapuja: amíg az nem teljesül, a következő fázis nem indul.

### F0 – Éles Meta (2026. október 15. – november 15.)

- [ ] Meta App Review beadása a 12 engedélyre, screencastekkel, a `hub.g2amarketing.hu` domainen
- [ ] Jogi oldalak (adatkezelés, ÁSZF, adattörlés) véglegesítése, a „Tervezet” jelölés levétele
- [ ] Visszatöltési próba a napi mentésből, riasztások bekötése (worker-szívverés, DEAD feladatok, bizonytalan Meta-küldés)
- [ ] Saját partnerek betöltése: MMI, VIBA-TEAM, Ste-Ba (Nissan + Chery), InnoK, G2A saját

**Kapu:** App Review jóváhagyva, és 2 hétig hiba nélkül publikál FB/IG-re legalább 3 partnernél.

### F1 – LinkedIn és az integrációs API (2026. november 16. – december 20.)

- [ ] LinkedIn-adapter: személyes profil (`w_member_social`), majd cégoldal (Community Management API-hozzáférés, ehhez külön LinkedIn-jóváhagyás kell – az igénylést már F0-ban be kell adni)
- [ ] A Growth Engine működő LinkedIn-kódjának átvétele mintának (`server/linkedinOAuth.ts`, `server/socialPublisher.ts` a growth_engine repóban), a Social Hub provider-felületére igazítva
- [ ] `/api/v1` az integrációs szerződés szerint: API-kulcsok a Beállításokban, `drafts`, `posts`, `clients`, valamint `metrics` és `brand-profile` végpontok (a Growth Engine G1 és G2 erre vár)
- [ ] Webhook-küldés az outbox-mintára: `post.approved`, `post.changes_requested`, `post.published`, `post.failed`
- [ ] JSON/CSV naptárimport a felületen is, a Claude havi tartalomnaptár-kimenetének formátumára

**Kapu:** egy teljes havi naptár (pl. MMI, 24 poszt) importból, jóváhagyással, LinkedInre és FB/IG-re publikálva.

### F2 – Ügynökségi mélység (2027. február)

- [ ] Havi jóváhagyás: az ügyfél egy linken látja a teljes hónapot, egyben vagy posztonként hagyja jóvá
- [ ] Karusszel és többképes poszt, Instagram Reels
- [ ] Első komment automatikusan, hashtag-készletek ügyfelenként
- [ ] Instagram-rácsnézet előnézete; naptár PDF-exportja az ügyfélnek

**Kapu:** a saját partnerek havi jóváhagyása teljesen a Social Hubban fut, e-mailes/Wordos oda-vissza nélkül.

### F3 – Ügyfélportál és Meta Ads adat (2027. április)

- [ ] Ügyfélportál: a partner képet, referencia-anyagot tölt fel a saját médiatárába
- [ ] Második Meta App Review az `ads_read` engedélyre, hirdetési metrikák szinkronja a `metrics` végpontba
- [ ] Kommentek: válaszsablonok, hozzárendelés csapattaghoz

**Kapu:** a Growth Engine havi riportja a Meta organikus és hirdetési adatot is a Social Hubból kapja.

### F4 – TikTok és pilot (2027. június)

- [ ] TikTok Content Posting API (auditig csak privát posztot enged, ezt be kell tervezni)
- [ ] 2–3 külső ügynökség pilotként, kedvezményes áron
- [ ] Számlázás és csomagok (a Growth Engine Stripe-kódja mint minta)

**Kapu:** legalább 2 fizető külső ügynökség, 3 hónap után is aktív.

## Amit nem építünk a Social Hubba

Ezek a Growth Engine-ben vannak vagy lesznek, ide csak API-n keresztül jutnak el:

- stratégiagenerálás, cégelemzés, versenytárs- és persona-elemzés
- havi tartalomnaptár AI-generálása (a Social Hub AI-ja posztszintű szövegjavaslatnál marad)
- GA4, Search Console, Google Ads kapcsolat és adat
- havi riport összeállítása és exportálása
- SEO-audit, videógenerálás, hírlevél, Copilot

Ha egy új ötlet ezek egyikéhez tartozik, a Growth Engine backlogjába kerül.

## Termék és értékesítés

| Csomag | Kinek | Mit tartalmaz |
| --- | --- | --- |
| Social Hub | Ügynökségek, freelancerek | Jóváhagyás, ütemezés, publikálás, kommentek, közösségi analitika, API |
| Growth Engine | Stratégiát és riportot akaró ügynökségek, KKV-k | Stratégia, tartalomtervezés, Google-adat, havi riport |
| G2A Hub (közös) | Ügynökségek teljes munkafolyamatra | Mindkettő, közös bejelentkezéssel, kedvezménnyel |
| Retainer-rész | A G2A saját partnerei | Ügyfélportál és havi jóváhagyás a havidíjban |

Az első év célja nem az önkiszolgáló regisztráció, hanem hogy a saját partnerek és 2–3 barát-ügynökség napi szinten használja.

## Nyitott kérdések és kockázatok

| Kockázat / kérdés | Hatás | Kezelés |
| --- | --- | --- |
| A Meta App Review elutasít vagy csúszik | F0 és minden ráépülő fázis késik | Beadás október végéig; addig fejlesztői módban, saját fiókokkal tesztelni |
| A LinkedIn cégoldal-hozzáférés nem kap jóváhagyást | A B2B partnerek cégoldalai nem publikálhatók | Igénylés már F0-ban; átmenetileg személyes profil |
| Egyetlen fejlesztő két termékkel | Mindkettő lassul | Egyszerre csak az egyik termék fázisa aktív |
| Közös bejelentkezés módja | F4 után dönteni | Javaslat: a Social Hub Better Auth-ja legyen az azonosító szolgáltató (OIDC) |
| Postiz mint belső alternatíva | Párhuzamos eszköz | F1 kapuja után a Postiz kivezetése a saját partnereknél |
