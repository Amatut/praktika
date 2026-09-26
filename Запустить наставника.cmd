@echo off
rem Практика: сервер ИИ-наставника на этом компьютере (http://127.0.0.1:8787).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установи LTS-версию с https://nodejs.org и запусти этот файл снова.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist .env (
  copy /y .env.example .env >nul
  echo Создан файл .env. Открываю его в Блокноте:
  echo вставь ключ после ANTHROPIC_API_KEY= , сохрани файл и запусти этот файл снова.
  start "" notepad .env
  pause
  exit /b 0
)

findstr /r /c:"^ANTHROPIC_API_KEY=..*" .env >nul
if errorlevel 1 (
  echo В файле .env не заполнен ANTHROPIC_API_KEY. Открываю его в Блокноте.
  start "" notepad .env
  pause
  exit /b 0
)

echo Наставник запускается. В приложении: Настройки → Наставник → «ИИ через сервер» → «Проверить соединение».
echo Каждый вопрос к ИИ — платный запрос. Чтобы остановить сервер, закрой это окно.
call npm run coach
pause
