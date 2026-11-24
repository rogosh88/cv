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
if not exist node_modules (
  echo Instaluje zaleznosci - tylko za pierwszym razem...
  call npm install --omit=dev
)
echo.
echo Monitor aukcji startuje: http://localhost:3000
echo Nie zamykaj tego okna - zamkniecie zatrzymuje monitor.
echo.
start "" http://localhost:3000
node src/server.js
pause
