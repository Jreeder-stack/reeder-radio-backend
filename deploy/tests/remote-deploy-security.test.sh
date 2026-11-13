#!/usr/bin/env bash
# Offline regression checks. NEVER connects to Azure or runs deploy commands.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/deploy/remote-deploy.sh"
bash -n "$script"
test ! -e "$root/attached_assets/commandcomms-key_1774361622787.pem"
! grep -Eq 'commandcomms-key_1774361622787|AZURE_SSH_KEY:-|StrictHostKeyChecking=no|UserKnownHostsFile=/dev/null' "$script"

workspace="$(mktemp -d)"
# Docker mounts /tmp as a temporary filesystem which can be noexec.
# Place ONLY the mock executable in the disposable source checkout.
fakebin="$(mktemp -d "$root/.deploy-security-bin.XXXXXXXX")"
repo_key="$root/.remote-deploy-test-private-key"
trap 'rm -rf "$workspace" "$fakebin"; rm -f "$repo_key"' EXIT

set +e
no_key_output="$(env -u AZURE_VM_SSH_KEY_FILE bash "$script" 2>&1)"
no_key_status=$?
set -e
[[ "$no_key_status" -ne 0 && "$no_key_output" == *"AZURE_VM_SSH_KEY_FILE"* ]] || {
  echo "Missing external SSH key was accepted"; exit 1;
}

printf 'not a real key\n' >"$repo_key"
chmod 600 "$repo_key"
if AZURE_VM_SSH_KEY_FILE="$repo_key" bash "$script" >"$workspace/repo.out" 2>&1; then
  echo "Source-tree key was accepted"; exit 1
fi
grep -q "inside the source checkout" "$workspace/repo.out"
rm "$repo_key"

key="$workspace/key"
printf 'not a real key\n' >"$key"
chmod 644 "$key"
if AZURE_VM_SSH_KEY_FILE="$key" bash "$script" >"$workspace/mode.out" 2>&1; then
  echo "World-readable key was accepted"; exit 1
fi
grep -q "accessible to group/other" "$workspace/mode.out"

chmod 600 "$key"
ln -s "$key" "$workspace/link"
if AZURE_VM_SSH_KEY_FILE="$workspace/link" bash "$script" >"$workspace/link.out" 2>&1; then
  echo "Symlink key was accepted"; exit 1
fi
grep -q "non-symlink regular file" "$workspace/link.out"

cat >"$fakebin/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$COMMAND_COMMS_SSH_TEST_ARGS"
exit 73
STUB
chmod 700 "$fakebin/ssh"
if COMMAND_COMMS_SSH_TEST_ARGS="$workspace/ssh.args" \
    PATH="$fakebin:$PATH" AZURE_VM_SSH_KEY_FILE="$key" \
    bash "$script" >"$workspace/stub.out" 2>&1; then
  echo "Stub SSH run unexpectedly succeeded"; exit 1
fi
if [[ ! -f "$workspace/ssh.args" ]]; then
  echo "SSH mock did not run; deploy launcher output follows:" >&2
  sed -n '1,18p' "$workspace/stub.out" >&2
  exit 1
fi
grep -Fxq "StrictHostKeyChecking=yes" "$workspace/ssh.args"
grep -Fxq "BatchMode=yes" "$workspace/ssh.args"
grep -Fxq "IdentitiesOnly=yes" "$workspace/ssh.args"
grep -Fxq "$key" "$workspace/ssh.args"
! grep -Fq "StrictHostKeyChecking=no" "$workspace/ssh.args"

echo "PASS: remote deploy requires external key and verified SSH host"
