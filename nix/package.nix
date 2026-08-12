{
  lib,
  rustPlatform,

  nodejs,
  npmHooks,
  fetchNpmDeps,

  pkg-config,

  cargo-tauri,

  gtk3,
  glib,
  glib-networking,
  webkitgtk_4_1,
  libsoup_3,
  openssl,

  libayatana-appindicator,
  gst_all_1,

  wrapGAppsHook4,

  copyDesktopItems,
  makeDesktopItem,
}:

rustPlatform.buildRustPackage rec {
  pname = "just-another-music-client";
  version = "1.3.2";

  src = lib.cleanSource ../.;

  cargoRoot = "src-tauri";
  cargoLock = {
    lockFile = "${src}/src-tauri/Cargo.lock";
  };

  npmDeps = fetchNpmDeps {
    inherit src;
    hash = "sha256-f3auOjY08783VNJQnzQHbi7h6ErGJhZi5ruPfJnf2x8=";
    forceGitDeps = true;
  };

  nativeBuildInputs = [
    nodejs
    npmHooks.npmConfigHook
    pkg-config
    cargo-tauri
    wrapGAppsHook4
    copyDesktopItems
  ];

  buildInputs = [
    gtk3
    glib
    glib-networking
    webkitgtk_4_1
    libsoup_3
    openssl

    libayatana-appindicator

    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-plugins-ugly
    gst_all_1.gst-libav
  ];

  buildPhase = ''
    runHook preBuild

    npm run build
    cargo tauri build --no-bundle

    runHook postBuild
  '';

  preCheck = ''
    cd src-tauri
  '';

  postCheck = ''
    cd ..
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 \
      src-tauri/target/release/${pname} \
      $out/bin/${pname}

    if [ -f src-tauri/icons/128x128.png ]; then
      install -Dm644 \
        src-tauri/icons/128x128.png \
        $out/share/icons/hicolor/128x128/apps/${pname}.png
    fi

    runHook postInstall
  '';

  preFixup = ''
    gappsWrapperArgs+=(
      --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath [ libayatana-appindicator ]}"
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${
        lib.makeSearchPathOutput "lib" "gstreamer-1.0" [
          gst_all_1.gstreamer
          gst_all_1.gst-plugins-base
          gst_all_1.gst-plugins-good
          gst_all_1.gst-plugins-bad
          gst_all_1.gst-plugins-ugly
          gst_all_1.gst-libav
        ]
      }"
    )
  '';

  desktopItems = [
    (makeDesktopItem {
      name = pname;
      desktopName = "Just Another Music Client";
      exec = pname;
      icon = pname;
      comment = meta.description;
      categories = [
        "AudioVideo"
        "Audio"
        "Music"
        "Player"
      ];
    })
  ];

  meta = with lib; {
    description = "Desktop music client";
    homepage = "https://github.com/2latemc/JustAnotherMusicClient";
    license = licenses.asl20;
    platforms = platforms.linux;
    mainProgram = "just-another-music-client";
  };
}
