@echo off
setlocal

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

echo [1/5] Copying native source files...
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
echo [2/5] Copying launcher icons...
for %%d in (mdpi hdpi xhdpi xxhdpi xxxhdpi) do (
    if not exist "%RES_DIR%\mipmap-%%d" mkdir "%RES_DIR%\mipmap-%%d"
    for %%i in (ic_launcher.png ic_launcher_round.png) do (
        if exist "%CONFIG_DIR%\res\mipmap-%%d\%%i" (
            copy /Y "%CONFIG_DIR%\res\mipmap-%%d\%%i" "%RES_DIR%\mipmap-%%d\%%i" >nul
        )
    )
    echo   -^> mipmap-%%d
)

if not exist "%RES_DIR%\mipmap-anydpi-v26" mkdir "%RES_DIR%\mipmap-anydpi-v26"
if exist "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher.xml" (
    copy /Y "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher.xml" "%RES_DIR%\mipmap-anydpi-v26\ic_launcher.xml" >nul
    copy /Y "%CONFIG_DIR%\res\mipmap-anydpi-v26\ic_launcher_round.xml" "%RES_DIR%\mipmap-anydpi-v26\ic_launcher_round.xml" >nul
    echo   -^> mipmap-anydpi-v26 (adaptive icons)
)

echo.
echo [3/5] Copying splash and foreground drawables...
if not exist "%RES_DIR%\drawable" mkdir "%RES_DIR%\drawable"
if exist "%RES_DIR%\drawable\splash.png" (
    del /Q "%RES_DIR%\drawable\splash.png"
    echo   -^> Removed default splash.png (conflicts with splash.xml)
)
for %%f in (ic_splash.png splash.xml ic_launcher_foreground.png) do (
    if exist "%CONFIG_DIR%\res\drawable\%%f" (
        copy /Y "%CONFIG_DIR%\res\drawable\%%f" "%RES_DIR%\drawable\%%f" >nul
        echo   -^> drawable\%%f
    )
)

echo.
echo [4/5] Copying notification icons...
for %%d in (mdpi hdpi xhdpi xxhdpi) do (
    if not exist "%RES_DIR%\drawable-%%d" mkdir "%RES_DIR%\drawable-%%d"
    if exist "%CONFIG_DIR%\res\drawable-%%d\ic_stat_icon.png" (
        copy /Y "%CONFIG_DIR%\res\drawable-%%d\ic_stat_icon.png" "%RES_DIR%\drawable-%%d\ic_stat_icon.png" >nul
        echo   -^> drawable-%%d\ic_stat_icon.png
    )
)

echo.
echo [5/5] Copying values and manifest...
if not exist "%RES_DIR%\values" mkdir "%RES_DIR%\values"
for %%f in (ic_launcher_background.xml colors.xml) do (
    if exist "%CONFIG_DIR%\res\values\%%f" (
        copy /Y "%CONFIG_DIR%\res\values\%%f" "%RES_DIR%\values\%%f" >nul
        echo   -^> values\%%f
    )
)

if exist "%CONFIG_DIR%\AndroidManifest.xml" (
    copy /Y "%CONFIG_DIR%\AndroidManifest.xml" "%ANDROID_DIR%\app\src\main\AndroidManifest.xml" >nul
    echo   -^> AndroidManifest.xml
)

echo.
echo === Setup complete ===
echo Open in Android Studio: npx cap open android
echo Build APK: Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)

endlocal
