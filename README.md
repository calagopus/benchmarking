![Calagopus Logo](https://calagopus.com/fulllogo.svg)

# Benchmarking

[![TypeScript](https://img.shields.io/badge/typescript-7-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/github/license/calagopus/benchmarking?color=blue)](https://github.com/calagopus/benchmarking/blob/main/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/calagopus/benchmarking)](https://github.com/calagopus/benchmarking/issues)
[![GitHub stars](https://img.shields.io/github/stars/calagopus/benchmarking)](https://github.com/calagopus/benchmarking/stargazers)
[![Discord](https://img.shields.io/discord/1429911351777824892?label=discord&logo=discord&color=5865F2)](https://discord.gg/uSM8tvTxBV)

benchmarking is the benchmarking suite for the Calagopus platform and various other Game panels, written in TypeScript. It is used to measure and
track the performance of Calagopus services under load.

## Usage

Each panel is booted from its own Docker Compose stack, swept across a set of CPU-quota variants, and driven with [`oha`](https://github.com/hatoo/oha)
while container CPU/memory are sampled. Requires `docker`, the `docker compose` plugin, and `oha` on `PATH`.

Pick a target as the first argument (defaults to `calagopus`):

```sh
pnpm run bench calagopus    # bench the Calagopus panel
pnpm run bench pterodactyl  # bench the Pterodactyl panel
pnpm run bench pelican      # bench the Pelican panel
pnpm run bench pufferpanel  # bench the PufferPanel panel
pnpm run bench featherpanel # bench the FeatherPanel panel
pnpm run bench hydrodactyl  # bench the Hydrodactyl panel

pnpm run bench pterodactyl --compare calagopus  # bench Pterodactyl and Calagopus in series, then compare results
pnpm run bench pufferpanel --compare calagopus  # bench PufferPanel and Calagopus in series, then compare results

pnpm run bench pterodactyl --compare pelican  # bench Pterodactyl and Pelican in series, then compare results (you will see a funny result)
```

## Contributing

You are free to contribute new panels, benchmarks, and improvements to the benchmarking suite. Please try to follow the existing code style and structure, and ensure that your contributions are tested.
