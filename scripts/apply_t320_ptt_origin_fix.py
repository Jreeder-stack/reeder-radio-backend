from pathlib import Path

client_path = Path('android-native/app/src/main/java/com/reedersystems/commandcomms/signaling/SignalingClient.kt')
client = client_path.read_text()
old = 'deviceId=${deviceId ?: \\"none\\"}'
new = 'deviceId=${deviceId ?: "none"}'
if old not in client:
    raise RuntimeError('escaped Kotlin quote sequence not found')
client_path.write_text(client.replace(old, new, 1))
Path('scripts/apply_t320_ptt_origin_fix.py').unlink()
Path('.github/workflows/apply-t320-ptt-origin-fix.yml').unlink()
