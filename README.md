<img width="2542" height="1468" alt="Logo_Header" src="https://github.com/user-attachments/assets/b897e500-b8b6-42f8-b956-70920a869db5" />

A desktop YouTube Music client built with Tauri, React, and TypeScript.

> **IMPORTANT**
>
> This is an independent, unofficial project and is not affiliated with, authorized by, sponsored by, or endorsed by YouTube or Google.
> 
>

## About

JustAnotherMusicClient brings YouTube Music to the desktop in a focused, native-feeling application. YouTube does not provide an official desktop client, so this project aims to provide a polished alternative that integrates with YouTube Music while keeping the experience fast and familiar.

## Features

- Browse, search, and play music from YouTube Music.
- Sign in to access your YouTube Music library, playlists, recommendations, and other account features.
- Add songs to your playlists.
- Create multiple music tabs, each with its own playback queue, volume, and player state.
- A polished desktop experience designed to work without getting in your way.

## Download

Download the newest available installer from the [latest release](https://github.com/2latemc/JustAnotherMusicClient/releases/latest).

## Platform Support

- Windows is the primary supported platform.
- macOS support is experimental and may have incomplete features or platform-specific issues.

## Prerequisites

Install these before running the app:

- Node.js LTS and npm
- [Rust and Cargo](https://rustup.rs/)
- Windows C++ build tools
- Microsoft Edge WebView2 Runtime

The Tauri CLI is included in the project's development dependencies. A global Tauri installation is not required.

## Install

```powershell
npm install
```

## Run

```powershell
npm run tauri dev
```

## Build

```powershell
npm run tauri build
```

## Contributing

Contributions are welcome. Fork the repository, create a branch for your change, test it locally, and open a pull request with a clear description of what you changed and why.

By submitting a contribution, you agree to the [Contributor License Agreement](CLA.md). You retain copyright in your contribution while granting the project owner the rights needed to use, modify, distribute, commercialize, and relicense it.

For larger changes, consider opening an issue first so the approach can be discussed before implementation.

## Common Issues

### Rust is not installed

Install Rust and Cargo from [rustup.rs](https://rustup.rs/), restart your terminal, and run the command again.

### WebView2 is missing

Install the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), then run the app again.

## Third-Party Services

The application interacts with YouTube and YouTube Music. Access to those services remains governed by their respective terms, policies, availability, and regional restrictions.

JustAnotherMusicClient does not host or claim ownership of music, videos, artwork, metadata, or other content supplied by third parties. Rights in that content remain with their respective owners.

The project is not intended to circumvent access controls, geographic restrictions, advertising, paid service requirements, or content licensing. It is also not intended to enable unauthorized downloading, copying, redistribution, or public performance of third-party content.

YouTube and YouTube Music are trademarks of Google LLC. All other trademarks are the property of their respective owners. References to third-party products are used only to describe compatibility and integration.

- [YouTube Terms of Service](https://www.youtube.com/static?template=terms)
- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
