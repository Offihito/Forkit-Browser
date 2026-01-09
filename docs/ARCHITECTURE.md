# Architecture Overview

This document describes the internal architecture of the Forkit Browser, including process separation, IPC communication, security model, and debugging infrastructure.

Forkit is built on **Electron** and follows a strict separation between system-level logic and UI logic for security, maintainability, and scalability.

-------

## High-Level Architecture

Forkit consists of three primary layers:

1. **Main Process**
2. **Preload Layer (Bridge API)**
3. **Renderer Process (UI)**

Each layer has a clearly defined responsibility and communicates only through explicit interfaces.

Main Process (Node.js)
│
│ IPC (message-based)
▼
Preload Layer (Secure API)
│
│ Exposed methods
▼
Renderer Process (Browser UI)