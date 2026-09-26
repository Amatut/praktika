@echo off
rem Практика: сборка и запуск на этом компьютере (http://127.0.0.1:4173).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установи LTS-версию с https://nodejs.org и запусти этот файл снова.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости, это займёт пару минут...
  call npm install
  if errorlevel 1 (
    echo Не удалось установить зависимости. Проверь интернет и попробуй снова.
    pause
    exit /b 1
  )
)

echo Собираю приложение...
call npm run build
if errorlevel 1 (
  echo Сборка не удалась — текст ошибки выше.
  pause
  exit /b 1
)

echo.
echo Практика открывается в браузере: http://127.0.0.1:4173
echo Чтобы остановить, закрой это окно или нажми Ctrl+C.
call npx vite preview --host 127.0.0.1 --port 4173 --strictPort --open
