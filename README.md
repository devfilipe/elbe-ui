# elbe-ui

![elbe-ui demo](spa/assets/elbe-ui.gif)

Web-based management interface for [ELBE (Embedded Linux Build
Environment)](https://elbe-rfs.org/). This is the primary deliverable of this
demo project: a FastAPI backend paired with a single-page application that
wraps the `elbe` CLI and related tooling, allowing embedded Linux images to be
built and tested entirely through a browser — without requiring users to
interact with the command line directly.

## Rationale

ELBE is a powerful build system, but its workflow is fundamentally CLI-driven:
every step — creating the initvm, submitting XML projects, polling build
status, downloading artifacts, managing a local APT repository, and booting
the resulting image — requires running multiple commands in the right order.
`elbe-ui` was created to provide a single, coherent graphical interface for
this workflow, reducing friction and making the toolchain more accessible.

The goals of this project are:

- Provide a GUI for the full ELBE build lifecycle without hiding the
  underlying tool (commands are logged and visible).
- Automate the repetitive steps of the custom-package workflow (build the
  `.deb`, add it to the local APT repo, rebuild the repo index, submit the
  image) so they can be triggered with one click.
- Offer an integrated QEMU simulator so built images can be booted and
  inspected directly from the browser, over a web-based serial console.
- Serve as a self-contained demo of how ELBE can be used in a CI/CD-like
  pipeline for embedded Linux development.

## Features

### initvm management

- Create, start, stop, and monitor the ELBE initvm (QEMU-backed build VM).
- Real-time status check: whether the QEMU process is running and whether the
  SOAP interface is reachable.

### Image builds

- List XML project files in the workspace and submit them for building with a
  single click.
- Builds run as background jobs; the live log is streamed to the browser.
- Configurable build concurrency (queue-based, with a per-server maximum).
- On failure, the UI automatically attempts to recover any partially built
  artifacts from the initvm.
- Per-build output directories under `builds/<project>-<job-id>/`.
- Cancel running jobs, remove finished entries, and manually trigger artifact
  downloads.

### XML editor

- Browse all ELBE XML files in the workspace.
- Read and write XML files from the browser.
- Validate XML against the ELBE schema (`elbe validate`).
- Preprocess XML (resolve XIncludes / variants).
- Upload external XML files.

### APT repository management

- Configure one or more local flat APT repositories.
- Generate GPG signing keys (using the maintainer identity from settings).
- Upload `.deb`, `.dsc`, and source tarball files into a repo.
- Rebuild the APT index (`Packages`, `Release`, `InRelease`) in one click.
- Delete packages and auto-rebuild the index.
- Generate ready-to-paste `sources.list` lines and ELBE XML `<url>` snippets
  for each configured repository.

### Source and package pipeline

- Browse source projects under `sources/` and Debian package definitions
  under `packages/`.
- Auto-generate a `debian/` scaffold (control, changelog, rules, source
  format) for a new package from a source project.
- Build binary (`.deb`) and optionally source (`.dsc` + `.tar.*`) packages
  with `dpkg-buildpackage`.
- Download build artifacts directly from the browser.
- Add built packages to a local APT repository and rebuild the index in a
  single step.
- Manage the `<pkg-list>` entries of ELBE XML files: add or remove packages
  and save the result.

### QEMU simulator

- Define one or more QEMU simulator configurations (disk image path, memory,
  extra arguments).
- Start and stop QEMU instances from the browser.
- Interact with the running machine through an in-browser serial console
  (WebSocket-backed pseudo-terminal): GRUB menus, kernel boot messages, and
  the login shell all appear in the browser.
- Browse and select bootable images produced by the build pipeline.

### Builds browser

- List all build output directories.
- Extract compressed image archives (`.tar.xz`, `.tar.gz`).
- Read build logs and XML files in the browser.
- Delete build directories.

### Settings

- All configurable paths (initvm directory, workspace, projects, sources,
  packages, output) are editable through the UI without restarting the server.
- Maintainer identity (name, email, organization) used for package metadata
  and GPG key generation.
- Default QEMU binary, memory, and extra arguments.

## Stack

| Component | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, Uvicorn |
| Frontend | Single-page application (SPA) served as static files |
| ELBE interface | Subprocess calls to `elbe` CLI and `elbe control` (SOAP) |
| QEMU console | Pseudo-terminal + WebSocket |

## Quick start

> The full workspace is assembled via `repo` (Google Repo) from the
> [`elbe-demo-manifest`](https://github.com/devfilipe/elbe-demo-manifest).
> The recommended way to run `elbe-ui` is inside the dev container provided
> by [`elbe-devcontainers`](https://github.com/devfilipe/elbe-devcontainers),
> which starts the UI automatically.

### Manual startup (inside the container)

```bash
cd /workspace/tools/elbe-ui
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

The UI is then available at <http://localhost:8080> (mapped to port **8383**
on the host when using the dev container).

## Configuration

Settings are persisted in `settings.json` next to `main.py` and can be edited
through the `/api/settings` endpoint or the Settings page in the UI. Key
settings:

| Setting | Default | Description |
|---|---|---|
| `elbe_bin` | `elbe` | Path to the `elbe` executable |
| `initvm_dir` | `/workspace/.elbe/initvm` | ELBE initvm directory |
| `workspace_dir` | `/workspace` | Workspace root |
| `projects_dir` | `/workspace/projects` | Directory containing ELBE XML files |
| `sources_dir` | `/workspace/sources` | Directory containing source projects |
| `packages_dir` | `/workspace/packages` | Directory containing Debian package definitions |
| `output_dir` | `/workspace` | Root for build output (`builds/` subdirectory) |
| `qemu_bin` | `qemu-system-x86_64` | Default QEMU binary for the simulator |
| `qemu_memory` | `1024` | Default QEMU memory (MiB) |
| `max_concurrent_submits` | `1` | Maximum number of simultaneous ELBE builds |

## License

See the [LICENSE](LICENSE) file.
