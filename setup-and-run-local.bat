@echo off
setlocal EnableExtensions DisableDelayedExpansion

if /I "%~1"=="api" goto child_api
if /I "%~1"=="web" goto child_web
if /I "%~1"=="product-worker" goto child_product_worker
if /I "%~1"=="messenger-worker" goto child_messenger_worker
if /I "%~1"=="messenger-send-worker" goto child_messenger_send_worker
if /I "%~1"=="followup-worker" goto child_followup_worker
if /I "%~1"=="audio-worker" goto child_audio_worker
if /I "%~1"=="image-worker" goto child_image_worker

cd /d "%~dp0"
title Alzeena Local Setup

echo ============================================================
echo  Alzeena AI Sales Agent - Safe Local Setup and Runner
echo ============================================================
echo.
echo This script will not submit an order, run a product sync,
echo send a Messenger message, or deploy anything.
echo.

call :check_command node "Node.js 20.9 or newer is required."
if errorlevel 1 goto failed
call :check_command npm "npm 10 or newer is required."
if errorlevel 1 goto failed
call :check_command docker "Docker Desktop is required and must be running."
if errorlevel 1 goto failed

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop is installed but the Docker Engine is not running.
  echo Start Docker Desktop, wait until it is ready, then run this file again.
  goto failed
)
echo [OK] Node, npm, and Docker are available.

if not exist ".env" (
  if not exist ".env.example" (
    echo [ERROR] .env.example was not found.
    goto failed
  )
  copy /Y ".env.example" ".env" >nul
  echo [ACTION REQUIRED] A new .env file was created.
  echo Add ADMIN_PASSWORD and GEMINI_API_KEY, verify DATABASE_URL, save it,
  echo then run this file again. Do not commit or share the .env file.
  start "Alzeena environment" notepad.exe ".env"
  goto incomplete
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%~A"=="" set "%%~A=%%~B"
)

call :require_env DATABASE_URL
if errorlevel 1 goto env_incomplete
call :require_env REDIS_URL
if errorlevel 1 goto env_incomplete
call :require_env ADMIN_PASSWORD
if errorlevel 1 goto env_incomplete
call :require_env GEMINI_API_KEY
if errorlevel 1 goto env_incomplete

echo [OK] Required environment values are present. Values are not displayed.

if not exist "node_modules\.package-lock.json" (
  echo [RUN] Installing exact npm dependencies...
  call npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    goto failed
  )
) else (
  echo [SKIP] node_modules already exists.
)

if not exist "node_modules\@prisma\client\index.js" (
  echo [RUN] Generating Prisma Client...
  call npm run prisma:generate
  if errorlevel 1 (
    echo [ERROR] Prisma Client generation failed.
    goto failed
  )
) else (
  echo [SKIP] Prisma Client package already exists.
)

echo [RUN] Starting PostgreSQL and Redis...
docker compose up -d postgres redis
if errorlevel 1 (
  echo [ERROR] Docker services could not be started.
  echo A local PostgreSQL installation may already own port 5432.
  echo Configure the Docker PostgreSQL host port and DATABASE_URL consistently.
  goto failed
)

set "ENV_DB_PORT="
for /f %%P in ('powershell -NoProfile -Command "try { ([uri]$env:DATABASE_URL).Port } catch { exit 1 }"') do set "ENV_DB_PORT=%%P"
set "DOCKER_DB_PORT="
for /f "tokens=2 delims=:" %%P in ('docker compose port postgres 5432 2^>nul ^| findstr /B "0.0.0.0"') do set "DOCKER_DB_PORT=%%P"
if not defined ENV_DB_PORT (
  echo [ERROR] DATABASE_URL is not a valid PostgreSQL URL.
  goto failed
)
if not defined DOCKER_DB_PORT (
  echo [ERROR] Docker PostgreSQL host port could not be determined.
  goto failed
)
if not "%ENV_DB_PORT%"=="%DOCKER_DB_PORT%" (
  echo [ERROR] Port mismatch: DATABASE_URL uses %ENV_DB_PORT%, Docker publishes %DOCKER_DB_PORT%.
  echo Update DATABASE_URL or compose.yml so both ports match, then run again.
  goto failed
)
echo [OK] DATABASE_URL and Docker both use port %ENV_DB_PORT%.

echo [WAIT] Waiting for PostgreSQL...
for /L %%I in (1,1,30) do (
  docker compose exec -T postgres pg_isready -U alzeena -d alzeena_agent >nul 2>&1 && goto postgres_ready
  timeout /t 2 /nobreak >nul
)
echo [ERROR] PostgreSQL did not become ready in 60 seconds.
goto failed

:postgres_ready
echo [OK] PostgreSQL is ready.
echo [WAIT] Waiting for Redis...
for /L %%I in (1,1,30) do (
  docker compose exec -T redis redis-cli ping >"%TEMP%\alzeena-redis-health.txt" 2>&1
  findstr /X /C:"PONG" "%TEMP%\alzeena-redis-health.txt" >nul && goto redis_ready
  timeout /t 2 /nobreak >nul
)
echo [ERROR] Redis did not become ready in 60 seconds.
goto failed

:redis_ready
echo [OK] Redis is ready.

echo [RUN] Generating the current Prisma Client...
call npm run prisma:generate
if errorlevel 1 (
  echo [ERROR] Prisma Client generation failed.
  goto failed
)

echo [RUN] Applying pending database migrations...
call npm run db:migrate:deploy
if errorlevel 1 (
  echo [ERROR] Database migration failed.
  echo Check DATABASE_URL and ensure its port matches Docker PostgreSQL.
  goto failed
)

echo [RUN] Applying the idempotent local seed...
call npm run db:seed
if errorlevel 1 (
  echo [ERROR] Database seed failed.
  goto failed
)

echo [RUN] Verifying database facts and required settings...
call npm run db:verify
if errorlevel 1 (
  echo [ERROR] Database verification failed.
  goto failed
)

echo [RUN] Verifying the database package build...
call npm run build --workspace=@alzeena/database
if errorlevel 1 (
  echo [ERROR] Database TypeScript build failed.
  goto failed
)

echo [START] API server...
start "Alzeena API" "%ComSpec%" /k ""%~f0" api"
echo [WAIT] Waiting for the API health endpoint...
for /L %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:4000/api/health; if($r.status -eq 'ok'){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1 && goto api_ready
  timeout /t 2 /nobreak >nul
)
echo [ERROR] API did not become healthy in 60 seconds.
echo Inspect the separate "Alzeena API" window for the exact error.
goto failed

:api_ready
echo [OK] API is healthy.
start "Alzeena Web" "%ComSpec%" /k ""%~f0" web"
start "Alzeena Product Worker" "%ComSpec%" /k ""%~f0" product-worker"
start "Alzeena Messenger Events" "%ComSpec%" /k ""%~f0" messenger-worker"
start "Alzeena Messenger Sender" "%ComSpec%" /k ""%~f0" messenger-send-worker"
start "Alzeena Followups" "%ComSpec%" /k ""%~f0" followup-worker"
start "Alzeena Audio Worker" "%ComSpec%" /k ""%~f0" audio-worker"
start "Alzeena Image Worker" "%ComSpec%" /k ""%~f0" image-worker"

echo.
echo ============================================================
echo  Local services started successfully
echo ============================================================
echo  Customer UI:  http://localhost:3000
echo  Admin UI:     http://localhost:3000/admin
echo  API health:   http://localhost:4000/api/health
echo  Readiness:    http://localhost:4000/api/health/readiness
echo.
echo Product sync and real order submission are intentionally manual.
echo Do not send "confirm" for an order until the real-order checklist is complete.
echo Each service has its own window. Close those windows or press Ctrl+C to stop.
echo.
pause
exit /b 0

:env_incomplete
echo [ACTION REQUIRED] Complete the missing values in .env and run again.
start "Alzeena environment" notepad.exe ".env"
goto incomplete

:check_command
where %~1 >nul 2>&1
if errorlevel 1 (
  echo [ERROR] %~2
  exit /b 1
)
exit /b 0

:require_env
call set "CURRENT_VALUE=%%%~1%%"
if not defined CURRENT_VALUE (
  echo [MISSING] %~1
  exit /b 1
)
if /I "%CURRENT_VALUE%"=="YOUR_STRONG_ADMIN_PASSWORD" (
  echo [MISSING] %~1 still contains a placeholder.
  exit /b 1
)
if /I "%CURRENT_VALUE%"=="YOUR_REAL_GEMINI_API_KEY" (
  echo [MISSING] %~1 still contains a placeholder.
  exit /b 1
)
echo [OK] %~1 configured.
exit /b 0

:incomplete
echo.
echo Setup is incomplete. No application services were started.
pause
exit /b 2

:failed
echo.
echo ============================================================
echo  SETUP STOPPED DUE TO AN ERROR
echo ============================================================
echo Read the first [ERROR] above. Existing containers and data were not deleted.
pause
exit /b 1

:child_api
cd /d "%~dp0"
title Alzeena API
call npm run dev:api
if errorlevel 1 echo [ERROR] API process stopped with an error.
goto child_end

:child_web
cd /d "%~dp0"
title Alzeena Web
call npm run dev:web
if errorlevel 1 echo [ERROR] Web process stopped with an error.
goto child_end

:child_product_worker
cd /d "%~dp0"
title Alzeena Product Worker
call npm run dev:worker
if errorlevel 1 echo [ERROR] Product worker stopped with an error.
goto child_end

:child_messenger_worker
cd /d "%~dp0"
title Alzeena Messenger Events
call npm run dev:messenger-worker
if errorlevel 1 echo [ERROR] Messenger event worker stopped with an error.
goto child_end

:child_messenger_send_worker
cd /d "%~dp0"
title Alzeena Messenger Sender
call npm run dev:messenger-send-worker
if errorlevel 1 echo [ERROR] Messenger sender stopped with an error.
goto child_end

:child_followup_worker
cd /d "%~dp0"
title Alzeena Followups
call npm run dev:followup-worker
if errorlevel 1 echo [ERROR] Followup worker stopped with an error.
goto child_end

:child_audio_worker
cd /d "%~dp0"
title Alzeena Audio Worker
call npm run dev:audio-worker
if errorlevel 1 echo [ERROR] Audio worker stopped with an error.
goto child_end

:child_image_worker
cd /d "%~dp0"
title Alzeena Image Worker
call npm run dev:image-worker
if errorlevel 1 echo [ERROR] Image worker stopped with an error.
goto child_end

:child_end
echo.
echo This window is being kept open so the error remains visible.
pause
exit /b 1
