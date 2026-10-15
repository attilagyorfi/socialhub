# G2A Growth Engine – fejlesztési terv

Állapot: 2026-10-15 · Gazda: Győrfi Attila
Párterv: `SOCIAL_HUB_TERV.md` (ugyanebben a mappában) – az **integrációs szerződés** ott van. Élő változat: https://claude.ai/code/artifact/94b0ce6b-a24f-4e00-90bf-0c2107e0bcfc

A Growth Engine a G2A termékcsalád tervező és elemző rétege: stratégia, tartalomtervezés, Google-adat és havi riport. **Nem publikál.** A kész vázlatokat a Social Hubba küldi, a közösségi adatot onnan kapja.

## Szerep és határvonal

Szabály: **közösségi platform és Meta = Social Hub; stratégia, Google- és webes adat = Growth Engine.** A Growth Engine-ből emiatt kikerül minden, ami közösségi fiókhoz nyúl.

| Modul | Döntés | Indoklás |
| --- | --- | --- |
| Onboarding, cégelemzés, stratégia + verziók | Marad, ez a mag | Ez a különbség a Social Hubhoz és a sima ChatGPT-hez képest |
| Tartalom Stúdió, AI-író, kampányok | Marad, tervező eszközként | A kimenete vázlat, ami a Social Hubba megy |
| Riportok | Marad, prioritás | Ma minden adat mock; ez lesz a legnagyobb üzleti érték |
| SEO-audit | Marad | Webes adat, a Growth Engine területe |
| Copilot | Marad | A stratégiát és a riportot látja, ott hasznos |
| Közösségi OAuth (FB, IG, TikTok), Meta-app | Kivezetendő | A Social Hub Meta-appja az egyetlen |
| LinkedIn OAuth és publikálás | Kivezetendő, de csak a Social Hub LinkedIn-adaptere után | Addig ez az egyetlen működő LinkedIn-publikálás |
| Percenkénti időzítő, „Közzétesz most” | Kivezetendő | A Social Hub workere megbízhatóbb |
| Leads / outbound táblák | Törlendő | Nincs hozzá felület, az útvonalak már átirányítanak |
| HeyGen-videó, hírlevél | Befagyasztva | Nem a fő érték, karbantartást visz |

## Közös ütemterv

Egy fejlesztő, ezért egyszerre egy termék fázisa aktív. Kivétel az első hónap: a Social Hub F0 főleg Meta-várakozás, ez alatt a Growth Engine takarítása fut.

| Időszak | Fázis |
| --- | --- |
| 2026. okt 15 – nov 15 | SH F0 · Éles Meta  ∥  **GE G0 · Takarítás** |
| 2026. nov 16 – dec 20 | SH F1 · LinkedIn + API v1 (erre épül a GE G1 és G2) |
| 2027. jan 4 – jan 31 | **GE G1 · Valós adat, riport** |
| 2027. február | SH F2 · Ügynökségi mélység |
| 2027. március | **GE G2 · Integráció és kivezetés** |
| 2027. április | SH F3 · Portál, Meta Ads |
| 2027. május | **GE G3 · Zárt kör** |
| 2027. június | SH F4 · TikTok, pilot |

Ha egy kapu csúszik, az utána következő fázisok is csúsznak, nem párhuzamosítunk.

## Integráció: a Social Hub API használata

A Growth Engine a Social Hub `/api/v1` API-jának kliense. A végpontok pontos listája a `SOCIAL_HUB_TERV.md` „Integrációs szerződés” részében van; itt az áll, amit a Growth Engine oldalán kell megépíteni.

- **Kapcsolat beállítása.** Beállítások → Integrációk → Social Hub: API-kulcs és webhook-titok, titkosítva tárolva (a meglévő `tokenCrypto` mintájára).
- **Ügyfél-párosítás.** A `client_profiles` tábla új `external_ref` mezőt kap; a párosítás a Social Hub `GET /clients` listájából választható.
- **„Küldés a Social Hubba” gomb.** A Tartalom Stúdióban, a naptárban és a Copilot-javaslatoknál a „Közzétesz most” és az ütemezés helyére kerül. Egy poszt vagy egy teljes hónap megy `POST /drafts`-szal, idempotencia-kulccsal.
- **Állapot visszafelé.** Webhook-fogadó (`/api/integrations/socialhub`): `post.approved`, `post.changes_requested`, `post.published`, `post.failed`. A `content_posts` állapota ebből frissül, a Growth Engine már nem állítja át magától.
- **AI-memória.** A jóváhagyott és visszaküldött posztok (az ügyfél megjegyzésével) betáplálják az `ai_memories` táblát.
- **Márkaprofil.** A márka-DNS, a márkahang, a tiltott/kötelező kifejezések és a pillérek mentéskor `PUT /brand-profile`-lal mennek át. A Social Hub ezekkel blokkolja a szabálysértő posztot.
- **Metrikák.** A riport-szinkron a közösségi (FB, IG, LinkedIn, később Meta Ads) adatot `GET /metrics`-szel kéri le, a `report_metrics` táblába írja, a Google-adat mellé.

## Fejlesztési fázisok

### G0 – Takarítás és határ (2026. október 15. – november 15.)

- [ ] A Growth Engine Meta-appja nem megy App Review-ra; FB/IG/TikTok csatlakozás kikapcsolva kapcsolóval (a kód a G2 végéig marad)
- [ ] Manus-maradványok törlése: `manus` LLM-ág, OAuth-bridge `users` tábla, `.manus` mappák, `__manus__` asset
- [ ] Leads/outbound táblák és halott útvonalak törlése migrációval
- [ ] Landing: a „Sales” modul és az alá nem támasztott „10x” állítás levétele; árazási blokk elrejtése a pilotig
- [ ] README és fejlesztői dokumentáció frissítése a valós állapotra (Railway, Anthropic/OpenAI, Stripe kész)
- [ ] HeyGen-videó és hírlevél befagyasztása kapcsolóval
- [ ] Háttérben indul: Google OAuth-app ellenőrzése (`analytics.readonly`, `webmasters.readonly`) és Google Ads developer token igénylése – ezek hetekig tartanak (a felhasználó adja be, a kód készítse elő)

**Kapu:** zöld CI, a landing csak létező funkciót ígér, a Google-ellenőrzés és a developer token beadva.

### G1 – Valós adat és havi riport (2027. január)

Függés: a Social Hub F1 (`GET /metrics`) kész.

- [ ] GA4 Data API, Search Console Search Analytics, Google Ads API-adapter a `fetchMetrics` mockágának helyére; `LIVE_METRIC_PLATFORMS` platformonként bekapcsolva
- [ ] Közösségi metrikák a Social Hubból (`GET /metrics`), ugyanabba a `report_metrics` táblába
- [ ] Napi szinkron háttérfeladatként, hibánál újrapróbálással és értesítéssel
- [ ] .docx export a „TELJESÍTMÉNY MINTA” szerkezetében: csatornánkénti számozott szakaszok, számok + értelmezés, záró „Vezetői értékelés”
- [ ] Szerveroldali PDF (a `renderReportPdf` stub kiváltása)
- [ ] AI-narratíva valós adatból; a nagy visszaeséseket magyarázattal írja (pl. kampány nélküli hónap)
- [ ] Alárkák külön riportban (pl. Dr K Phillips klinika + termék, Ste-Ba Nissan + Chery)

**Kapu:** a VIBA-TEAM és az InnoK januári vezetői összefoglalója kézi export nélkül készül el.

### G2 – Integráció és kivezetés (2027. március)

Függés: a Social Hub F1 (LinkedIn és `/api/v1`) kész és legalább egy hónapja élesben fut.

- [ ] Social Hub kapcsolat a Beállításokban, `external_ref` párosítás
- [ ] „Küldés a Social Hubba” (egy poszt / teljes hónap), a „Közzétesz most” és az ütemezés helyett
- [ ] Webhook-fogadó, állapotfrissítés, AI-memória táplálása a jóváhagyási döntésekből
- [ ] Márkaprofil-szinkron (`PUT /brand-profile`) mentéskor
- [ ] Törlés: `scheduler.ts`, `socialPublisher.ts`, `publishing.ts`, a közösségi OAuth-fájlok, `social_connections`, `scheduled_posts`, `social_tokens` táblák

**Kapu:** egy teljes hónap tartalma a Growth Engine-ben készül, a Social Hubban hagyják jóvá és publikálják, a Growth Engine-ben már nincs publikáló kód.

### G3 – Zárt kör (2027. május)

- [ ] Teljesítmény-visszacsatolás: a publikált posztok metrikái alapján pillérenkénti értékelés és javaslat a következő havi naptárhoz
- [ ] Stratégiai feladatok státusza a tényleges publikálásból (pl. „heti 3 LinkedIn-poszt” teljesül-e)
- [ ] Riport-ütemezés: a havi riport a hónap első munkanapján vázlatként kész, kísérőlevél-piszkozattal
- [ ] Közös bejelentkezés előkészítése a Social Hub tervében rögzített döntés szerint

**Kapu:** a havi ciklus (terv → jóváhagyás → publikálás → riport → következő terv) legalább 3 partnernél két hónapig emberi másolgatás nélkül fut.

## Befagyasztott és törölt modulok

| Modul | Állapot | Mikor nyúlunk hozzá újra |
| --- | --- | --- |
| HeyGen-videó (Videó Stúdió) | Befagyasztva | Ha egy fizető ügyfél kéri, G3 után |
| Hírlevél | Befagyasztva | Ha a saját G2A-hírlevél elindul |
| Leads / outbound | Törölve (G0) | Saját outboundhoz külön eszköz kell, nem ez |
| Közösségi OAuth, időzítő, publikálás | Kivezetve (G2) | Soha: ez a Social Hub dolga |
| Manus-integráció | Törölve (G0) | – |

Befagyasztva = a kód megmarad, kapcsolóval elrejtve, új fejlesztés és hibajavítás nincs rajta.

## Termék és értékesítés

- **Önállóan:** stratégia, tartalomtervezés, SEO-audit, havi riport Google-adattal.
- **A Social Hubbal („G2A Hub”):** a tervezett tartalom egy kattintással jóváhagyásra megy, a riport a közösségi adatot is tartalmazza.
- **Saját partnereknek:** a havi riport és a stratégia a retainer része.

A Stripe-kód kész, de nyilvános önkiszolgáló regisztráció csak a G3 kapuja után induljon.

## Nyitott kérdések és kockázatok

| Kockázat / kérdés | Hatás | Kezelés |
| --- | --- | --- |
| A Google OAuth-ellenőrzés vagy a developer token csúszik | G1 csak részben élő | Igénylés G0-ban; addig GA4 és GSC tesztfelhasználókkal |
| LinkedIn-rés a kivezetés és a Social Hub adapter között | B2B partnereknél kiesés | A LinkedIn-kód csak a G2 végén törlődik |
| MySQL (GE) és PostgreSQL (SH) egymás mellett | Két adatbázis üzemeltetése | Elfogadjuk; átállás csak közös kódalapnál |
| Ugyanazt az AI-funkciót mindkét termék építi | Dupla munka | Posztszint: Social Hub; hónap- és stratégiaszint: Growth Engine |
| A .docx riport formátuma | Eltérhet a meglévő mintától | A G1 elején a „TELJESÍTMÉNY MINTA” sablonból indulni |
