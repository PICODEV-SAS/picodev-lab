# Picodev Lab, a fork of Velxio

> **This repository is a fork of [Velxio](https://github.com/davidmonterocrespo24/velxio)**,
> the open-source Arduino and embedded board emulator written by
> **[David Montero Crespo](https://github.com/davidmonterocrespo24)**,
> and like Velxio it is licensed under the **GNU AGPLv3**.
> Almost all of the code here is his. Velxio's own README, unchanged, is
> [`README.md`](../README.md); the live project is at [velxio.dev](https://velxio.dev).

Picodev Lab is the browser editor of the [Picodev](https://picodev.fr) lab
demo: visitors write Arduino code, compile it and run it in simulation, and in
a later stage on real test benches. It is Velxio restricted to a few AVR boards,
with a Picodev look and a guard in front of the compiler.

## What this fork changes

Nothing in Velxio's behaviour unless a deployment file asks for it. Without one,
the image built from this repository is stock Velxio.

| Where | What |
| --- | --- |
| [`picodev/`](../picodev/) | Everything Picodev adds: the editor overlay, the backend guard and its tests, the Docker image, the example deployment file |
| A few Velxio files | Small configuration patches, each falling back to the stock behaviour and written to be proposed upstream |

Details, the list of patched files and how the fork follows Velxio releases:
[`picodev/README.adoc`](../picodev/README.adoc).

## Credits and license

- **Velxio** © David Montero Crespo and its contributors, under the
  [GNU AGPLv3](../LICENSE). Velxio is also offered under a
  [commercial license](../COMMERCIAL_LICENSE.md) by its author.
- **This fork** is published under the same GNU AGPLv3. The running Picodev Lab
  service links to this repository, so every user can get the source of the
  editor they use. Each release is published here as one commit with its tag.
- Improvements useful to every Velxio user are proposed to the
  [original project](https://github.com/davidmonterocrespo24/velxio) rather than
  kept here. If you like the emulator, star and
  [sponsor Velxio](https://github.com/sponsors/davidmonterocrespo24).
