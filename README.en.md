# Vault WIP

An Obsidian desktop plugin. When several machines take turns on the same vault, it warns you before you start writing that another one still has uncommitted changes.

[中文说明](README.md)

> **This plugin does not work on its own.** It needs a relay server; see [WIP Relay](https://github.com/y1chu666/wip-relay). The plugin collects local state and raises the warning, and the relay carries it between devices.

> [!NOTE]
> This project is implemented by AI, with the ideas, requirements and judgement provided by a human. Scope, trade-offs and acceptance criteria are decided by the human; code, documentation and tests are written by AI.

## The problem

A note vault is rarely used on one machine only. When two machines are used alternately rather than at the same time, the real risk is not simultaneous editing:

1. Machine A is left with uncommitted changes and is shut down.
2. Machine B keeps writing, commits and pushes.
3. Back on machine A, the next pull runs straight into a conflict.

Version control mentions the conflict only at that point, when the damage is done. Vault WIP moves the warning earlier: it records the uncommitted state of each device's working tree and tells the user, as a file is opened, saved or a window gains focus, whether another device still has uncommitted changes and which files they touch.

It can also ask a remote on the user's behalf, if one is named in the settings: which commits each side has not merged yet, so the user knows before pulling. That check is read-only too, and its result stays on this machine.

## What it does not do

- It does not upload note content. Devices exchange file paths and state summaries, not text.
- It performs no git write operations. Collection only reads repository status; it never commits, pulls, pushes or switches branches.
- It does not replace Obsidian Git or any sync tool. Tools such as `git-diff-sync` and `mob` carry uncommitted changes to another machine; this plugin carries nothing and only reports state.
- It does not target mobile. Desktop only: Windows, macOS and Linux.

## Security

A device's identity is a key pair generated locally, and content keys never leave the user's devices. A relay only carries records and cannot read them.

## Getting started

Obsidian on the desktop is required, plus a machine that can stay on to run the relay (a machine on the local network will do).

1. On the relay machine, run `wip-relay init` and `wip-relay serve`. `init` writes a sample configuration and a registration credential; the credential is shown only once. See [Server](https://github.com/y1chu666/wip-relay/blob/main/docs/server.md) in the WIP Relay repository.
2. Build the plugin and place `main.js`, `manifest.json` and `styles.css` in `.obsidian/plugins/vault-wip/` inside the vault, then enable it in Obsidian. See [Plugin](docs/client.md).
3. In the plugin settings, fill in the relay address and the registration credential, then register. Register the other devices of the same vault under the same vault alias, and hand them the content key as described in the "Security" tab of the status view.

The plugin's release page carries the three files and checksums; server binaries are on the [WIP Relay release page](https://github.com/y1chu666/wip-relay/releases).

## Version compatibility

Plugin and relay are paired by record format. Starting with `0.2.0` the format is v2, which is not compatible with `0.1.0`; both sides must be upgraded together. A relay does not parse record content, but it does take part in record signature verification, so it has to be upgraded whenever the format changes.

## Documentation

The design documents are written in Chinese:

- [Design](docs/design.md)
- [Plugin](docs/client.md)
- [Testing](docs/testing.md)

The protocol and server documents live in the WIP Relay repository: [protocol](https://github.com/y1chu666/wip-relay/blob/main/docs/protocol.md), [server](https://github.com/y1chu666/wip-relay/blob/main/docs/server.md).

## License

Released under the Apache License 2.0; the full text is in [LICENSE](LICENSE). You may use, modify and redistribute it, including commercially, as long as the license text travels with it and modified files are marked as changed. The software comes as is, without warranty of any kind.
