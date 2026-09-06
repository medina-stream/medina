# Deployment units

These are the units running Medina on its exe.dev VM, kept in the repo as a
working reference rather than as a general installer. They encode choices
this deployment made; read them before copying.

## What is exe.dev-specific

`archil-mount.service` mounts an [Archil](https://archil.com) disk and names
a particular account and disk (`sco@scottraymond.net/medina-dev`). Archil is
one way to give `DATA_DIR` durable cloud-backed storage. **Medina does not
require it** — `DATA_DIR` is an ordinary writable directory, so on a normal
machine you can skip this unit entirely and point `DATA_DIR` at local disk.

`medina-dev.service` declares `Requires=archil-mount.service`, which is
correct *here*: this deployment's `DATA_DIR` lives on that mount, and
starting the server before the data is mounted would let it materialize
artifacts into an empty directory. If your `DATA_DIR` is local, drop both
the `Requires=` and `After=` lines.

Both units also assume the exe.dev VM's `exedev` user, `/home/exedev` paths,
and Bun at `~/.bun/bin`.

## Adapting them

1. Copy the unit, edit `User`, `Group`, `WorkingDirectory` and `PATH`.
2. Drop the `archil-mount` dependency unless you are using Archil.
3. Point `DATA_DIR` (in `.env`) wherever your data should live. If it is on
   a mount, keep an equivalent `Requires=`/`After=` on whatever provides it.
4. Install and enable:

   ```sh
   sudo cp medina-dev.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now medina-dev
   ```

The server binds `127.0.0.1` by default and does not authenticate reads, so
whatever you run in front of it is doing the authenticating. See "Exposure
and identity" in the README before setting `HOST=0.0.0.0`.
