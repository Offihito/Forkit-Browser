#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_PATH="$ROOT_DIR/src-tauri/target/release/forkit"
ICON_PATH="$ROOT_DIR/build/icon.png"
OUT_DIR="$ROOT_DIR/dist-linux"
VERSION="1.3.0"
ARCH_DEB="amd64"
ARCH_RPM="x86_64"

if [ ! -f "$BIN_PATH" ]; then
  echo "Release binary not found at $BIN_PATH. Building..."
  cargo build --release --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DESKTOP_CONTENT="[Desktop Entry]
Name=Forkit
Comment=Fast, lightweight web browser
Exec=/usr/bin/forkit %U
Icon=forkit
Terminal=false
Type=Application
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupWMClass=forkit
"

# 1. Build .tar.gz
TAR_STAGE="$WORK_DIR/forkit-$VERSION-linux-$ARCH_RPM"
mkdir -p "$TAR_STAGE"
cp "$BIN_PATH" "$TAR_STAGE/forkit"
chmod 755 "$TAR_STAGE/forkit"
cp "$ICON_PATH" "$TAR_STAGE/forkit.png"
printf "%s" "$DESKTOP_CONTENT" | sed 's|Exec=/usr/bin/forkit %U|Exec=/usr/local/bin/forkit %U|' > "$TAR_STAGE/forkit.desktop"
tar -C "$WORK_DIR" -czf "$OUT_DIR/forkit-$VERSION-linux-$ARCH_RPM.tar.gz" "forkit-$VERSION-linux-$ARCH_RPM"
echo "Created: $OUT_DIR/forkit-$VERSION-linux-$ARCH_RPM.tar.gz"

# 2. Build .deb
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB_STAGE="$WORK_DIR/deb"
  mkdir -p "$DEB_STAGE/DEBIAN" \
           "$DEB_STAGE/usr/bin" \
           "$DEB_STAGE/usr/share/applications" \
           "$DEB_STAGE/usr/share/icons/hicolor/512x512/apps"
  cp "$BIN_PATH" "$DEB_STAGE/usr/bin/forkit"
  chmod 755 "$DEB_STAGE/usr/bin/forkit"
  cp "$ICON_PATH" "$DEB_STAGE/usr/share/icons/hicolor/512x512/apps/forkit.png"
  printf "%s" "$DESKTOP_CONTENT" > "$DEB_STAGE/usr/share/applications/forkit.desktop"

  INSTALLED_SIZE=$(du -sk "$DEB_STAGE/usr" | cut -f1)
  cat > "$DEB_STAGE/DEBIAN/control" <<EOF
Package: forkit
Version: $VERSION
Section: web
Priority: optional
Architecture: $ARCH_DEB
Installed-Size: $INSTALLED_SIZE
Depends: libwebkit2gtk-4.1-0, libgtk-3-0
Maintainer: Offihito <offihito@example.com>
Description: Forkit Browser
 Fast, lightweight native GTK3 + WebKitGTK web browser.
EOF

  chmod 755 "$DEB_STAGE/DEBIAN"
  chmod 644 "$DEB_STAGE/DEBIAN/control"
  cat > "$DEB_STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
EOF
  chmod 755 "$DEB_STAGE/DEBIAN/postinst"
  dpkg-deb --build --root-owner-group "$DEB_STAGE" "$OUT_DIR/forkit_${VERSION}_${ARCH_DEB}.deb"
  echo "Created: $OUT_DIR/forkit_${VERSION}_${ARCH_DEB}.deb"
else
  echo "Skipped .deb: dpkg-deb not found"
fi

# 3. Build .rpm (if rpmbuild is available)
if command -v rpmbuild >/dev/null 2>&1; then
  RPM_TOP="$WORK_DIR/rpmbuild"
  mkdir -p "$RPM_TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
  cp "$BIN_PATH" "$RPM_TOP/SOURCES/forkit"
  cp "$ICON_PATH" "$RPM_TOP/SOURCES/forkit.png"
  printf "%s" "$DESKTOP_CONTENT" > "$RPM_TOP/SOURCES/forkit.desktop"

  cat > "$RPM_TOP/SPECS/forkit.spec" <<EOF
Name:           forkit
Version:        $VERSION
Release:        1%{?dist}
Summary:        Forkit Browser
License:        MIT
URL:            https://github.com/Offihito/Forkit-Browser

%description
Fast, lightweight native GTK3 + WebKitGTK web browser.

%install
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/256x256/apps
install -m 755 %{_sourcedir}/forkit %{buildroot}%{_bindir}/forkit
install -m 644 %{_sourcedir}/forkit.desktop %{buildroot}%{_datadir}/applications/forkit.desktop
install -m 644 %{_sourcedir}/forkit.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/forkit.png

%files
%{_bindir}/forkit
%{_datadir}/applications/forkit.desktop
%{_datadir}/icons/hicolor/256x256/apps/forkit.png
EOF

  rpmbuild --define "_topdir $RPM_TOP" -bb "$RPM_TOP/SPECS/forkit.spec"
  find "$RPM_TOP/RPMS" -name "*.rpm" -exec cp {} "$OUT_DIR/" \;
  echo "Created .rpm in $OUT_DIR"
else
  echo "Skipped .rpm: rpmbuild not installed (install rpm-tools to build .rpm)"
fi

ls -lh "$OUT_DIR"
