@echo off
setlocal enabledelayedexpansion

set "ANDROID_DIR=%~dp0android"
set "CONFIG_DIR=%~dp0android-config"
set "JAVA_DIR=%ANDROID_DIR%\app\src\main\java\com\reedersystems\commandcomms"
set "RES_DIR=%ANDROID_DIR%\app\src\main\res"

if not exist "%ANDROID_DIR%" (
    echo ERROR: android\ directory not found.
    echo Run these commands first:
    echo   npm run build
    echo   npx cap add android
    echo   npx cap sync android
    exit /b 1
)

echo === Command Comms Android Setup ===
echo.

if not exist "%JAVA_DIR%" mkdir "%JAVA_DIR%"

echo [1/6] Copying native source files...
for %%f in (BackgroundAudioService.java BackgroundServicePlugin.java BootReceiver.java DndOverridePlugin.java HardwarePttPlugin.java PttBroadcastReceiver.java MainActivity.java) do (
    if exist "%CONFIG_DIR%\%%f" (
        copy /Y "%CONFIG_DIR%\%%f" "%JAVA_DIR%\%%f" >nul
        echo   -^> %%f
    )
)
for %%f in (LiveKitPlugin.kt RadioVoiceDSP.kt) do (
    if exist "%CONFIG_DIR%\%%f" (
        copy /Y "%CONFIG_DIR%\%%f" "%JAVA_DIR%\%%f" >nul
        echo   -^> %%f
    )
)

echo.
echo [2/6] Copying launcher icons...
for %%d in (mdpi hdpi xhdpi xxhdpi xxxhdpi) do (
    if not exist "%RES_DIR%\mipmap-%%d" mkdir "%RES_DIR%\mipmap-%%d"
    if exist "%CONFIG_DIR%\res\mipmap-%%d\ic_launcher.png" (
        copy /Y "%CONFIG_DIR%\res\mipmap-%%d\ic_launcher.png" "%RES_DIR%\mipmap-%%d\ic_launcher.png" >nul
    )
    if exist "%CONFIG_DIR%\res\mipmap-%%d\ic_launcher_round.png" (
        copy /Y "%CONFIG_DIR%\res\mipmap-%%d\ic_launcher_round.png" "%RES_DIR%\mipmap-%%d\ic_launcher_round.png" >nul
    )
    echo   -^> mipmap-%%d
)

if not exist "%RES_DIR%\mipmap-anydpi-v26" mkdir "%RES_DIR%\mipmap-anydpi-v26"
if exist "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher.xml" (
    copy /Y "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher.xml" "%RES_DIR%\mipmap-anydpi-v26\ic_launcher.xml" >nul
    copy /Y "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher_round.xml" "%RES_DIR%\mipmap-anydpi-v26\ic_launcher_round.xml" >nul
    echo   -^> mipmap-anydpi-v26 (adaptive icons^)
)

echo.
echo [3/6] Copying splash and foreground drawables...
if not exist "%RES_DIR%\drawable" mkdir "%RES_DIR%\drawable"
del /F /Q "%RES_DIR%\drawable\splash.png" 2>nul
echo   -^> Cleaned default splash.png
if exist "%CONFIG_DIR%\res\drawable\ic_splash.png" (
    copy /Y "%CONFIG_DIR%\res\drawable\ic_splash.png" "%RES_DIR%\drawable\ic_splash.png" >nul
    echo   -^> drawable\ic_splash.png
)
if exist "%CONFIG_DIR%\res\drawable\splash.xml" (
    copy /Y "%CONFIG_DIR%\res\drawable\splash.xml" "%RES_DIR%\drawable\splash.xml" >nul
    echo   -^> drawable\splash.xml
)
if exist "%CONFIG_DIR%\res\drawable\ic_launcher_foreground.png" (
    copy /Y "%CONFIG_DIR%\res\drawable\ic_launcher_foreground.png" "%RES_DIR%\drawable\ic_launcher_foreground.png" >nul
    echo   -^> drawable\ic_launcher_foreground.png
)

echo.
echo [4/6] Copying notification icons...
for %%d in (mdpi hdpi xhdpi xxhdpi) do (
    if not exist "%RES_DIR%\drawable-%%d" mkdir "%RES_DIR%\drawable-%%d"
    if exist "%CONFIG_DIR%\res\drawable-%%d\ic_stat_icon.png" (
        copy /Y "%CONFIG_DIR%\res\drawable-%%d\ic_stat_icon.png" "%RES_DIR%\drawable-%%d\ic_stat_icon.png" >nul
        echo   -^> drawable-%%d\ic_stat_icon.png
    )
)

echo.
echo [5/6] Copying values and manifest...
if not exist "%RES_DIR%\values" mkdir "%RES_DIR%\values"
if exist "%CONFIG_DIR%\res\values\ic_launcher_background.xml" (
    copy /Y "%CONFIG_DIR%\res\values\ic_launcher_background.xml" "%RES_DIR%\values\ic_launcher_background.xml" >nul
    echo   -^> values\ic_launcher_background.xml
)
if exist "%CONFIG_DIR%\res\values\colors.xml" (
    copy /Y "%CONFIG_DIR%\res\values\colors.xml" "%RES_DIR%\values\colors.xml" >nul
    echo   -^> values\colors.xml
)

if exist "%CONFIG_DIR%\AndroidManifest.xml" (
    copy /Y "%CONFIG_DIR%\AndroidManifest.xml" "%ANDROID_DIR%\app\src\main\AndroidManifest.xml" >nul
    echo   -^> AndroidManifest.xml
)

echo.
echo [6/6] Verifying icon files...
set "VERIFY_OK=1"
for %%d in (mdpi hdpi xhdpi xxhdpi xxxhdpi) do (
    call :checkIcon "%%d"
)
call :checkForeground
if "!VERIFY_OK!"=="1" (
    echo   All icons verified successfully.
) else (
    echo   WARNING: Some icons may not have been copied correctly!
)

echo.
echo === Setup complete ===
echo.
echo IMPORTANT: If updating an existing install on the device,
echo UNINSTALL the old app first to clear the cached icon.
echo   adb uninstall com.reedersystems.commandcomms
echo.
echo Open in Android Studio: npx cap open android
echo Build APK: Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)

endlocal
goto :eof

:checkIcon
set "DENSITY=%~1"
set "ICON_PATH=%RES_DIR%\mipmap-%DENSITY%\ic_launcher.png"
if exist "%ICON_PATH%" (
    for %%F in ("%ICON_PATH%") do set "FSIZE=%%~zF"
    if !FSIZE! LSS 1000 (
        echo   WARNING: mipmap-%DENSITY%\ic_launcher.png too small (!FSIZE! bytes^)
        set "VERIFY_OK=0"
    ) else (
        echo   OK: mipmap-%DENSITY%\ic_launcher.png (!FSIZE! bytes^)
    )
) else (
    echo   MISSING: mipmap-%DENSITY%\ic_launcher.png
    set "VERIFY_OK=0"
)
goto :eof

:checkForeground
set "FG_PATH=%RES_DIR%\drawable\ic_launcher_foreground.png"
if exist "%FG_PATH%" (
    for %%F in ("%FG_PATH%") do set "FSIZE=%%~zF"
    echo   OK: drawable\ic_launcher_foreground.png (!FSIZE! bytes^)
) else (
    echo   MISSING: drawable\ic_launcher_foreground.png
    set "VERIFY_OK=0"
)
goto :eof
