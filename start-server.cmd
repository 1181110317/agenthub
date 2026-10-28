@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 goto directory_error
where node >nul 2>&1
if errorlevel 1 goto node_error
node "%~dp0lib\startup-launcher.cjs"
set "AH_START_EXIT=%ERRORLEVEL%"
goto finish

:directory_error
echo [ERROR] 无法进入 AgentHub 所在目录：%~dp0
set "AH_START_EXIT=1"
goto finish

:node_error
echo [ERROR] 找不到 Node.js。请安装 Node.js 22.19 或更新版本，然后重新打开此脚本。
set "AH_START_EXIT=1"

:finish
if "%AH_START_EXIT%"=="0" goto done
echo.
echo [ERROR] 启动未成功，请查看上面的错误信息。
if "%AGENTHUB_NO_PAUSE%"=="1" goto done
pause
:done
exit /b %AH_START_EXIT%
