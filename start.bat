@echo off
rem ============================================================
rem  xyzw_web_helper - 一键启动前端开发服务器
rem  等价于: pnpm dev (Vite, 端口 3000, 自动打开浏览器)
rem  仅本地使用; 不含依赖安装 / Node 版本校验
rem
rem  用法:
rem    1. 双击运行 (在 Windows 资源管理器中)
rem    2. 或在任意 cmd/PowerShell 中执行: e:\zyd\xyzw_web_helper\start.bat
rem
rem  前置条件:
rem    - 已在项目根目录执行过 pnpm install
rem    - pnpm 已加入 PATH (通过 nvm4w 或独立安装均可)
rem ============================================================

chcp 65001 >nul
setlocal EnableExtensions

rem 切换到脚本所在目录, 支持从任意路径调用
cd /d "%~dp0"

if not exist "package.json" (
    echo.
    echo [ERROR] package.json not found.
    echo [HINT ] Please put start.bat in the project root.
    echo.
    pause
    endlocal
    exit /b 1
)

if not exist "node_modules" (
    echo.
    echo [ERROR] node_modules not found.
    echo [HINT ] Run 'pnpm install' in the project root first.
    echo.
    pause
    endlocal
    exit /b 1
)

echo.
echo [INFO ] Project dir : %CD%
echo [INFO ] Starting Vite dev server on port 3000 ...
echo [INFO ] Browser will open automatically.
echo [INFO ] Press Ctrl+C in this window to stop.
echo.

call pnpm dev
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo [ERROR] pnpm dev exited with code %EXITCODE%
    pause
)

endlocal & exit /b %EXITCODE%
