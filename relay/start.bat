@echo off
chcp 65001 >nul
setlocal

rem Переходим в папку, где лежит этот файл
cd /d "%~dp0"
if exist "server.js" goto find_node
echo.
echo Не найден файл server.js рядом со start.bat.
echo Скорее всего, start.bat запущен прямо из zip-архива.
echo Сначала распакуйте архив: правый клик по boosty-twitch-chat.zip - "Извлечь все...",
echo потом откройте распакованную папку boosty-twitch-chat\relay и запустите start.bat оттуда.
echo.
pause
exit /b 1

:find_node
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE=%ProgramW6432%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto run

rem Node.js, установленный через fnm (winget install Schniz.fnm + fnm install)
where fnm >nul 2>nul
if errorlevel 1 goto no_node
for /f "delims=" %%i in ('fnm env --shell cmd 2^>nul') do call %%i
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto run

:no_node
echo.
echo Node.js не найден.
echo 1. Откройте https://nodejs.org/ru/download и скачайте установщик Windows (.msi).
echo 2. Запустите скачанный .msi и нажимайте "Далее" до конца.
echo 3. Перезагрузите компьютер и снова запустите start.bat.
echo.
pause
exit /b 1

:run
echo Node.js: "%NODE_EXE%"
start "" http://127.0.0.1:8787/
"%NODE_EXE%" server.js
pause
