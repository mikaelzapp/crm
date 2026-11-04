@echo off
setlocal
cd /d "%~dp0"
if not exist .env (
  echo Execute instalar.bat primeiro.
  exit /b 1
)
docker compose up -d
if errorlevel 1 exit /b 1
docker compose ps
echo Acesse http://localhost:3000 apos o servico web ficar saudavel.
