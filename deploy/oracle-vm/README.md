# StarNet on an Oracle Cloud VM

Runs the StarNet station headless (the `npm start` sidecar) as a systemd service. The station stays bound to
`127.0.0.1` — its API guard (`sidecar/apiauth.js`) only admits loopback Hosts — so you open it through an SSH
tunnel. No ingress rule, firewall change, or TLS certificate is needed, and nothing is exposed to the internet.

## 1. Create the VM

- Image: Canonical Ubuntu 24.04 (or Oracle Linux 9). Shape: `VM.Standard.A1.Flex` (Always Free ARM) with
  2+ OCPU / 12+ GB RAM is comfortable; x86 shapes work too.
- Add your SSH public key. Leave the default security list (port 22 only).
- The subnet needs an **egress** rule to `0.0.0.0/0` (the default security list has one): setup downloads Node and
  packages, and the station calls model providers. Check with `curl -sI https://github.com` on the VM — a timeout
  means the egress rule is missing (VCN → subnet → security list → Add Egress Rule, all protocols).

## 2. Install

```bash
ssh ubuntu@<vm-public-ip>
sudo apt-get update && sudo apt-get install -y git   # a fresh image has empty package lists and may lack git
git clone https://github.com/Mcgyver-ai/starnet-workforge.git starnet
cd starnet
bash deploy/oracle-vm/setup.sh
gh auth login   # automatic updates read CI results with this; skip it and they fail every 15 minutes
```

The script installs Node 22, build tools and the GitHub CLI (`gh`), runs `npm ci --omit=dev`, writes `/etc/systemd/system/starnet.service`,
starts it, and waits for `GET /api/health`. Re-run it any time; it is idempotent.

## 3. Open it from your PC

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@<vm-public-ip>
```

Then browse to `http://127.0.0.1:8787` (use `127.0.0.1`, not `localhost`, which can resolve to `::1`).
Add provider keys in the app as usual. A headless station has no OS keychain, so credentials sit in plaintext under
the workspaces directory (`~/.local/share/StarNet/workspaces`, or `STARNET_WORKSPACES`): provider keys in
`.secrets/provider-keys.json` and `.bak`, channel tokens in `channels/secrets.json` and `.bak`. Your browser also keeps
its own copy of the provider key. Remove those files when you wipe or hand over the VM.

For phone access without a tunnel, pair StarNet Remote from the app: the station dials out to the default relay
(`remote.starnetos.com`), which only forwards end-to-end sealed frames. `STARNET_REMOTE_RELAY=off` in
`/etc/starnet/starnet.env` turns it off.

## Operate

| Task | Command |
| --- | --- |
| Logs | `journalctl -u starnet -f` |
| Restart | `sudo systemctl restart starnet` |
| Update | Automatic: `starnet-update.timer` runs `deploy/oracle-vm/auto-update.sh` every 15 min (see below) |
| Update now | `sudo systemctl start starnet-update` then `journalctl -u starnet-update -n 20` |
| Env overrides | `/etc/starnet/starnet.env` (`STARNET_PORT`, `STARNET_WORKSPACES`, …), then restart |
| Back up data | `sudo systemctl stop starnet`, copy the workspaces directory (`~/.local/share/StarNet/workspaces` or your `STARNET_WORKSPACES`), then `sudo systemctl start starnet`. Copying while agents run is not a consistent recovery point. The copy includes the plaintext credentials above. |

## Automatic updates

`setup.sh` installs `starnet-update.timer`. Every 15 minutes it fetches the branch the checkout is on and, only when
every GitHub check on the new commit has passed, fast-forwards, runs `npm ci` if `package-lock.json` changed,
restarts the station, and rolls back to the previous commit if `/api/health` does not answer within 30 s. A commit
that had to be rolled back is not tried again until a newer one lands; to retry it now, delete
`.git/starnet-failed-commit`. It pulls; nothing in GitHub can reach the VM. It needs `gh auth login` on the VM to read
the check results (a VM set up before `setup.sh` installed `gh` needs `setup.sh` re-run first), and it refuses to
update over local edits or a non-fast-forward. One failed check holds the update until that check is re-run or a
newer commit passes. A restart interrupts runs in flight (the station resumes journaled runs on boot). Turn it off with `sudo systemctl disable --now starnet-update.timer`.

Agents run tools as the service user with that user's file access, so give the VM its own user and keys —
don't reuse credentials you would not hand to the agents.
