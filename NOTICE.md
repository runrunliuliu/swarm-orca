# Notices

This repository combines a reviewed Orca source snapshot with Swarm orchestration code.

## Orca source snapshot

- Source directory: `orca/`
- Upstream repository declared by the package: <https://github.com/stablyai/orca>
- Imported package version: `1.4.219`
- Upstream baseline tag: `v1.4.219`
- Upstream baseline commit: `e705cac04a1db7e7e2184746e912142d34ca838b`
- License file: `orca/LICENSE` (`MIT License`, copyright Lovecast Inc.)

See `orca/UPSTREAM.md` and `orca/upstream.json` for provenance details.

## Bundled resources and third-party notices

The Orca snapshot includes bundled assets and runtime resources inherited from upstream. The currently identified checked-in third-party notice bundle is:

- `orca/resources/licenses/ripgrep/README.md` and sibling license files for the bundled `ripgrep` binaries and their statically linked components.

Before a public release, re-run the resource/license review against the exact release commit and keep any required upstream notices with the distributed artifacts.

## Swarm code

The `swarm/` directory was copied from the private integration workspace's tracked Swarm submodule files and then publicized. Confirm the final repository-level open-source license before publishing; this notice records provenance and bundled third-party notices, but does not by itself choose a license for code that lacks an explicit license header.
