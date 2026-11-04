@echo off
setlocal
cd /d "%~dp0"
docker compose version >nul 2>&1
if errorlevel 1 (
  echo Instale e inicie o Docker Desktop com WSL2 antes de continuar.
  exit /b 1
)
powershell -NoProfile -File scripts\configure.ps1
if errorlevel 1 exit /b 1
docker compose config --quiet
if errorlevel 1 exit /b 1
docker compose up -d --build
if errorlevel 1 exit /b 1
echo Aguarde os servicos ficarem saudaveis. Acesse http://localhost:3000.
echo Consulte ADMIN_EMAIL e ADMIN_PASSWORD no arquivo .env local.
