# T320 over-the-air updates

## One-time bootstrap

Every existing T320 must receive one manual install of a build that contains the OTA service in `app/src/t320`. This is the final USB/ADB install required for normal software updates. The radio must remain provisioned as Android Device Owner so `PackageInstaller` can perform unattended in-place updates.

The bootstrap APK and every future OTA APK must use the **same signing key**. If the currently installed T320 app was built with a debug key, use that same keystore for the bootstrap if possible. If the existing signing key is unavailable, Android will not allow an in-place signature change; the one-time bootstrap will require uninstall/re-provision before installing the permanently signed OTA build.

## Server configuration

Set a strong random `OTA_PUBLISH_TOKEN` on the Command Comms backend. The same value must be stored as the GitHub Actions secret `OTA_PUBLISH_TOKEN`. Also create the Actions secret `OTA_BASE_URL` with the production Command Comms origin, for example `https://comms.reeder-systems.com`.

OTA release APKs are stored in Postgres in `radio_ota_releases`; rollout state is stored in `radio_ota_assignments`. This avoids relying on Render's ephemeral filesystem.

## Signing configuration

Store a permanent Android signing keystore in GitHub Actions secrets. Do not generate a new key for each workflow run. Required secrets are:

- `T320_KEYSTORE_BASE64` — base64 of the keystore file
- `T320_KEYSTORE_PASSWORD`
- `T320_KEY_ALIAS`
- `T320_KEY_PASSWORD`

The workflow restores the keystore only inside the GitHub runner and builds `assembleT320Release`. The repository does not contain the private signing key.

## Pushing a release

Run the GitHub Actions workflow **Build and Push T320 OTA**. Supply an Android `versionCode` greater than the currently installed version and a display `versionName`. The workflow stamps the version, builds the permanently signed T320 release APK, keeps the APK as an Actions artifact, uploads the APK to Command Comms, and queues it to all registered radios.

The backend also exposes admin endpoints under `/api/radios/ota` to upload a signed APK, target selected radios, and inspect rollout status.

## Radio behavior

The T320 OTA service polls every 60 seconds and survives app closure, reboot, and package replacement. Before installation it verifies:

- the release version is newer than the installed build;
- the downloaded SHA-256 matches the server release;
- the APK package name matches Command Comms;
- the APK's internal versionCode matches the release metadata;
- Command Comms is Device Owner.

Updates are deferred while the radio is transmitting, receiving, channel-busy, handling emergency traffic, or in clear-air mode. Android's package signature validation remains authoritative during the actual in-place install, so an APK signed with a different key will be rejected rather than replacing the installed app.

## Rollout states

A radio reports `queued`, `deferred`, `downloading`, `downloaded`, `installing`, `installed`, or `failed`. After Android replaces the app, `MY_PACKAGE_REPLACED` restarts the OTA service and the new build reports the pending release as installed.
