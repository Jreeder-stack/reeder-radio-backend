# Command Comms SSH deployment key policy and rotation

## Required deployment credentials

The production GitHub workflow `.github/workflows/deploy.yml` uses the GitHub
Actions repository secret `AZURE_VM_SSH_KEY` for SSH and
`AZURE_VM_FINGERPRINT` for host identity. **No private key belongs in this
repository, its history, attached assets, application settings, CI logs, or
test fixtures.**

The manual `deploy/remote-deploy.sh` script requires
`AZURE_VM_SSH_KEY_FILE` to point to a trusted private-key file **outside**
the source tree (owner-only permissions, no symlinks). The host's
`known_hosts` must contain its verified host key; the script will fail closed
instead of disabling host-key verification.

## Recovery procedure for a leaked SSH key

A known exposed private key is **compromised**, even if the corresponding file
has been removed from the current branch. Neither a Git delete commit nor
`.gitignore` revokes SSH login access.

1. Confirm Azure VM ownership and obtain Azure portal/serial-console recovery
   access. Do not shut down or restart the live Command Comms process.
2. On a trusted administrative device, generate a **new unique SSH keypair**,
   preferably Ed25519. Keep its private half outside repositories and chats.
3. In Azure Portal open the VM, then **Help > Reset password >
   Reset SSH public key**, select the intended Linux user, and supply the
   **new public key**. An Azure VMAccess update may *append* a key instead of
   removing the old one; do not mistake this for revocation.
4. Verify login with the new private key or verify Azure Run Command/Serial
   Console recovery is working before revoking the old key. Update the
   `AZURE_VM_SSH_KEY` GitHub repository secret with the **new** key for
   automated deployments, plus the genuine server fingerprint as needed.
5. Revoke the old key from every applicable `authorized_keys` file (and any
   other known usage), via the Azure VM Run Command or an authenticated admin
   session. Confirm the old key can no longer authenticate. If there are other
   users or service accounts, retain only their separately authorized keys;
   do not blindly wipe all access without a recovery method.
6. Review Azure sign-in/SSH security logs and deployment history for unusual
   access. Rotate other potentially exposed credentials if discovered.
7. Coordinate Git history sanitation with all maintainers **after revocation**.
   Deleting a key from the HEAD tree does not purge old commits, tags, forks,
   release assets or caches. Rewriting public history requires a deliberate,
   independently verified plan for active branches, clones and open PRs;
   GitHub Support may be needed for cached copies. Treat the old key as
   compromised permanently regardless of history cleanup.
8. Before re-enabling manual deployment, configure
   `AZURE_VM_SSH_KEY_FILE=/absolute/path/outside/repo` and provision a
   verified SSH `known_hosts` entry. Run
   `bash deploy/tests/remote-deploy-security.test.sh` to verify source-side
   safeguards without connecting to the live server.

## Source changes and safety

- Do not commit private key files or certificate containers.
- The live GitHub Actions workflow is **not** invoked during a security-only
  source cleanup. Application release/deployment remains a separate decision.
- Never post private key material, private environment values, or actual
  `authorized_keys` contents in GitHub Issues, pull requests, or chats.
- Source-remediation status and live revocation status must be tracked
  separately; both are required to close an exposure incident.

Microsoft documents the Azure VM "Reset SSH public key", VMAccess key
appending, and VM Run Command options in the Azure Virtual Machines guides.
