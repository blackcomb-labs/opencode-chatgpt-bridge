@echo off
setlocal
title OpenCode ChatGPT Bridge - 8787

rem Portable Windows launcher. Save this file under scripts\.
rem Configure the private .env in the repository root first.
rem This file contains no tokens, passwords, or personal paths.

cd /d "%~dp0.." || (
  echo [ERROR] Cannot locate the repository directory.
  exit /b 1
)

where node >nul 2>&1 || (
  echo [ERROR] Node.js not found in PATH. Install Node.js 20 or later.
  exit /b 1
)

if not exist "dist\cli.js" (
  echo [ERROR] dist\cli.js not found. Run: pnpm install ^&^& pnpm run build
  exit /b 1
)

if not exist ".env" if not defined OPENCODE_BRIDGE_TOKEN (
  echo [ERROR] No local .env or OPENCODE_BRIDGE_TOKEN environment variable found.
  echo Run: node dist\cli.js init --allowed-roots "C:\Projects\my-repo"
  echo Then configure .env. Never commit the generated token.
  exit /b 1
)

node "dist\cli.js" start
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo [ERROR] Bridge exited with code %CODE%.
exit /b %CODE%
