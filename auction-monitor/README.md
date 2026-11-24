# Monitor aukcji aut CH → PL

Aplikacja (PWA – działa w przeglądarce i instaluje się na iPhonie) monitorująca aukcje aut ze Szwajcarii.
**X minut przed końcem aukcji (domyślnie 20)** liczy pełny koszt sprowadzenia auta do Polski
i porównuje go z cenami rynkowymi z **Otomoto** i **OLX** (+ ceny z **Facebook Marketplace** wpisane ręcznie).
Gdy koszt jest **co najmniej 30% poniżej** wartości rynkowej – wysyła powiadomienie.

## Jak liczy

```
koszt w PL = cena aukcji × kurs NBP
           + pozycje kosztowe po kolei (stałe kwoty lub % – od ceny auta albo narastająco)
wartość rynkowa = mediana porównywalnych ogłoszeń (rocznik ±1, przebieg ±35%, bez wartości odstających)
                  − rabat od cen ogłoszeniowych (domyślnie 5%)
okazja, gdy (wartość rynkowa − koszt w PL) / wartość rynkowa ≥ 30%
```

Aplikacja pokazuje też **maksymalną stawkę** w CHF, do której aukcja nadal jest okazją.

Domyślne pozycje kosztowe (wszystkie edytowalne w *Ustawienia → Koszty sprowadzenia*):

| Pozycja | Domyślnie |
|---|---|
| Transport w Szwajcarii | km garaż → sprzedający × 2 (w dwie strony) × 2 CHF/km |
| Transport CH → PL | 3500 PLN |
| Cło | 10% (narastająco) |
| Akcyza | 4% do 1999 cm³, 18% od 2000 cm³ (narastająco) |
| VAT | 23% (narastająco) |
| Agencja celna, badanie, rejestracja | 1500 PLN (przykład) |

Odległość liczona jest automatycznie z adresu garażu (ustawienia) i adresu sprzedającego (z aukcji):
geokodowanie OpenStreetMap (Nominatim) + trasa drogowa OSRM. Można ją też wpisać ręcznie przy aukcji.

## Logowanie na stronę aukcji

*Ustawienia → Strona z aukcjami*: adres strony logowania, login i hasło → *Sprawdź logowanie*.
Aplikacja sama wypełnia formularz logowania, trzyma sesję i loguje się ponownie, gdy sesja wygaśnie.
Hasło jest przechowywane tylko na serwerze (`data/settings.json`) i nie jest odsyłane do przeglądarki.

Ochrona konta przed blokadą: logowanie najwyżej raz na 30 min; po nieudanym logowaniu pauza 6 h (bez ponawiania)
i powiadomienie; min. 4 s odstępu między zapytaniami; sesja zapisywana na dysku (restart nie wymaga logowania);
cena odświeżana co 30 min, a w ostatnich ~23 min przed porównaniem co 2 min. Sprawdzić formułę możesz w zakładce *Kalkulator*.

## Uruchomienie

```bash
npm install
APP_PASSWORD=twoje-haslo npm start     # http://localhost:3000
npm test
```

Monitor musi działać 24/7 na serwerze (telefon nie może wykonywać zadań w tle).

### Serwer VPS (zalecane, ok. 20–25 zł/mies.)

1. Kup najmniejszy serwer VPS z Ubuntu (np. Hetzner CX22, OVH, Mikrus) i zaloguj się: `ssh root@IP_SERWERA`
2. Zainstaluj Dockera i pobierz aplikację:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone -b claude/swiss-car-auction-monitor-5gthw4 https://github.com/rogosh88/cv.git
   cd cv/auction-monitor
   cp .env.example .env && nano .env     # ustaw APP_PASSWORD i DOMAIN
   docker compose up -d --build
   ```
3. Otwórz `https://DOMAIN` (np. `https://203-0-113-10.sslip.io`) – certyfikat HTTPS tworzy się sam w ~1 min.

Aktualizacja: `git pull && docker compose up -d --build`. Logi: `docker compose logs -f app`.
Dane (aukcje, ustawienia, sesja) są w wolumenie Dockera `app-data` – przetrwają aktualizacje i restarty.

### Bez Dockera (np. Raspberry Pi w domu)

```bash
cd auction-monitor && npm ci --omit=dev
APP_PASSWORD=... npm start      # port 3000; HTTPS zapewnij np. przez Cloudflare Tunnel
```

Zmienne środowiskowe: `PORT`, `DATA_DIR`, `APP_PASSWORD`, opcjonalnie `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`.

## iPhone

1. Otwórz adres aplikacji (musi być **HTTPS**) w Safari → *Udostępnij* → *Dodaj do ekranu początkowego*.
2. Uruchom aplikację z ikony → *Ustawienia* → *Włącz powiadomienia na tym urządzeniu* (iOS 16.4+).
3. Alternatywnie / dodatkowo: **Telegram** (bot z @BotFather + chat ID) lub **ntfy** (aplikacja ntfy, wymyśl długi losowy temat).
   Przycisk *Wyślij testowe powiadomienie* sprawdza wszystkie kanały.

## Dodawanie aukcji

- Ręcznie w zakładce *Dodaj* (marka, model, rok, przebieg, paliwo, pojemność, cena, koniec aukcji, link).
- Hurtowo przez API: `POST /api/import` z tablicą obiektów (te same pola) – aukcje z tym samym `url` są aktualizowane.
- Cena jest odświeżana automatycznie ze strony aukcji (JSON-LD / meta tagi / selektory CSS z ustawień, opcjonalnie z ciasteczkiem sesji),
  a gdy się nie uda – przycisk *Zmień cenę*.

## Ograniczenia

- **Facebook Marketplace** wymaga logowania, blokuje automaty, a jego regulamin zabrania scrapowania – dlatego aplikacja
  generuje gotowy link wyszukiwania, a ceny wpisujesz przy aukcji (pole „Ceny z Facebook Marketplace”).
- Otomoto i OLX mogą zmienić strukturę strony lub ograniczać zapytania – wtedy przy aukcji widać błąd źródła.
  Można podać własny link wyszukiwania Otomoto / frazę OLX albo ręczną wartość rynkową.
- Ceny w ogłoszeniach to ceny wywoławcze, nie transakcyjne – stąd konfigurowalny rabat i opcja dolnego kwartyla.
