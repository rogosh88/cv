#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Brak Node.js. Zainstaluj wersję LTS ze strony https://nodejs.org i uruchom ten plik ponownie."
  open https://nodejs.org
  read -p "Naciśnij Enter, aby zamknąć..."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Instaluję zależności (tylko za pierwszym razem)..."
  npm install --omit=dev
fi
echo
echo "Monitor aukcji startuje: http://localhost:3000"
echo "Nie zamykaj tego okna – zamknięcie zatrzymuje monitor."
echo
(sleep 2 && open http://localhost:3000) &
node src/server.js
