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

Domyślne pozycje kosztowe są **przykładowe** (transport 3500 PLN, cło 10%, akcyza 3,1% / 18,6%, VAT 23%, opłaty 1500 PLN) –
wpisz swoje w *Ustawienia → Koszty sprowadzenia*. Sprawdzić formułę możesz w zakładce *Kalkulator*.

## Uruchomienie

```bash
npm install
APP_PASSWORD=twoje-haslo npm start     # http://localhost:3000
npm test
```

Monitor musi działać 24/7 na serwerze (telefon nie może wykonywać zadań w tle), np.:

- **VPS / Raspberry Pi**: `docker build -t aukcje . && docker run -d -p 3000:3000 -v aukcje-data:/data -e APP_PASSWORD=... aukcje`
- **Render / Railway / Fly.io**: deploy z Dockerfile, podłącz trwały wolumen pod `/data`, ustaw `APP_PASSWORD`.

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
