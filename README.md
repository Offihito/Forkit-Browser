# Forkit Browser 
Readme

## What is Forkit Browser?
Forkit Browser is a privacy-focused, portable Chromium-based browser modified specifically to bypass Deep Packet Inspection (DPI) systems used by ISPs and governments to detect and block encrypted traffic (SNI-based blocking, TLS fingerprinting, etc.).

It is a fork of Ungoogled Chromium + additional patches that make your HTTPS traffic extremely difficult to distinguish from regular browser traffic, even under the most aggressive DPI systems.

Repository: https://github.com/Offihito/Forkit-Browser

## Features
- Full TLS randomization (JA3/JA4 fingerprint randomization)
- HTTP/2 & HTTP/3 fingerprint randomization
- Randomized TLS extension order & GREASE support
- Real-time header order randomization
- Encrypted Client Hello (ECH) ready (when available on the server side)
- Built-in uBlock Origin (pre-configured strict lists)
- Ungoogled Chromium base (no Google telemetry)
- Portable – no installation required
- Automatic updates disabled by default (for maximum stealth)
- All known Chromium telemetry completely stripped

## Why you might need this
Many countries and ISPs now use advanced DPI to:
- Read the Server Name Indication (SNI) in TLS handshakes
- Block connections based on TLS fingerprint (JA3/JA4)
- Detect and throttle or block VPN/Proxy traffic
- Identify and block privacy tools in real time

Forkit Browser makes your traffic look like a completely normal, up-to-date Chrome/Edge/Firefox session from a random legitimate user – even when you visit blocked domains.
