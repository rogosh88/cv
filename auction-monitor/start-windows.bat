@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Brak Node.js. Zainstaluj wersje LTS ze strony https://nodejs.org i uruchom ten plik ponownie.
  start https://nodejs.org
  pause
  exit /b 1
)
echo Sprawdzam zaleznosci (pierwsze uruchomienie pobiera ok. 150 MB i trwa kilka minut)...
call npm install --omit=dev --no-audit --no-fund
call npx playwright install chromium
echo.
echo Monitor aukcji startuje: http://localhost:3000
echo Nie zamykaj tego okna - zamkniecie zatrzymuje monitor.
echo.
start "" http://localhost:3000
node src/server.js
pause
