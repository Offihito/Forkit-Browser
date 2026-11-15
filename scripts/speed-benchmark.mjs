#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_BIN = path.join(ROOT, "src-tauri", "target", "release", "forkit");
const DEBUG_BIN = path.join(ROOT, "src-tauri", "target", "debug", "forkit");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  let runs = 3;
  let timeoutMs = 20000;
  let build = false;
  let outFile = null;

  for (const arg of argv) {
    if (arg === "--build") {
      build = true;
    } else if (arg.startsWith("--runs=")) {
      const n = Number(arg.split("=")[1]);
      if (Number.isFinite(n) && n >= 1) runs = Math.floor(n);
    } else if (arg.startsWith("--timeout=")) {
      const n = Number(arg.split("=")[1]);
      if (Number.isFinite(n) && n >= 1000) timeoutMs = Math.floor(n);
    } else if (arg.startsWith("--out=")) {
      outFile = arg.slice("--out=".length);
    }
  }
  return { runs, timeoutMs, build, outFile };
}

function listAllProcesses() {
  if (process.platform !== "linux") return [];
  const entries = fs.readdirSync("/proc", { withFileTypes: true });
  const procs = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const pid = Number(ent.name);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, rparen);
      const rest = stat.slice(rparen + 2).split(" ");
      const ppid = Number(rest[1]);
      procs.push({ pid, ppid, comm });
    } catch {
      // Process exited while reading /proc
    }
  }
  return procs;
}

function getProcessTreePids(rootPid) {
  const all = listAllProcesses();
  const childrenMap = new Map();
  for (const p of all) {
    if (!childrenMap.has(p.ppid)) childrenMap.set(p.ppid, []);
    childrenMap.get(p.ppid).push(p);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift();
    const info = all.find((p) => p.pid === cur);
    if (info) result.push(info);
    for (const child of childrenMap.get(cur) || []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        queue.push(child.pid);
      }
    }
  }
  return result;
}

function readSmapsRollupKb(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const getKb = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Number(m[1]) : 0;
    };
    const pss = getKb("Pss");
    const rss = getKb("Rss");
    const priv = getKb("Private_Clean") + getKb("Private_Dirty");
    return { pss, rss, priv };
  } catch {
    return { pss: 0, rss: 0, priv: 0 };
  }
}

function measureTree(rootPid) {
  if (process.platform !== "linux") {
    return { processCount: 0, pssMb: 0, rssMb: 0, privMb: 0 };
  }
  const tree = getProcessTreePids(rootPid);
  let totalPssKb = 0;
  let totalRssKb = 0;
  let totalPrivKb = 0;
  for (const p of tree) {
    const m = readSmapsRollupKb(p.pid);
    totalPssKb += m.pss;
    totalRssKb += m.rss;
    totalPrivKb += m.priv;
  }
  return {
    processCount: tree.length,
    pssMb: totalPssKb / 1024,
    rssMb: totalRssKb / 1024,
    privMb: totalPrivKb / 1024,
  };
}

function killTree(rootPid) {
  if (process.platform === "linux") {
    const tree = getProcessTreePids(rootPid);
    for (const p of tree.reverse()) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {}
    }
  } else {
    try {
      process.kill(rootPid, "SIGTERM");
    } catch {}
  }
}

function resolveBinary(forceBuild) {
  if (forceBuild || (!fs.existsSync(RELEASE_BIN) && !fs.existsSync(DEBUG_BIN))) {
    console.log("Release binary derleniyor (cargo build --release)...");
    execFileSync("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
  if (fs.existsSync(RELEASE_BIN)) return RELEASE_BIN;
  return DEBUG_BIN;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    min: sorted[0],
    median,
    avg: sum / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

function fmtMs(val) {
  return `${val.toFixed(1)} ms`;
}

// --- Benchmark HTML Generators ---

function htmlStartup(label = "startup") {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Forkit Bench - ${label}</title></head>
<body>
  <h1 id="title">Forkit Speed Benchmark</h1>
  <script>
    const tDcl = { wall: 0, perf: 0 };
    document.addEventListener("DOMContentLoaded", () => {
      tDcl.wall = Date.now();
      tDcl.perf = performance.now();
    });
    window.addEventListener("load", () => {
      const loadWall = Date.now();
      const loadPerf = performance.now();
      const sendBeacon = (paintWall, paintPerf) => {
        const nav = performance.getEntriesByType("navigation")[0];
        fetch("/beacon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "page",
            label: ${JSON.stringify(label)},
            hidden: document.hidden,
            dclWallMs: tDcl.wall || loadWall,
            loadWallMs: loadWall,
            paintWallMs: paintWall,
            dclPerfMs: tDcl.perf || loadPerf,
            loadPerfMs: loadPerf,
            paintPerfMs: paintPerf,
            responseEndMs: nav ? nav.responseEnd : 0,
            domInteractiveMs: nav ? nav.domInteractive : 0
          })
        });
      };
      if (document.hidden) {
        sendBeacon(loadWall, loadPerf);
      } else {
        let sent = false;
        requestAnimationFrame(() => {
          if (sent) return;
          sent = true;
          sendBeacon(Date.now(), performance.now());
        });
        setTimeout(() => {
          if (sent) return;
          sent = true;
          sendBeacon(Date.now(), performance.now());
        }, 250);
      }
    });
  </script>
</body>
</html>`;
}

function htmlHeavyDom() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Forkit Bench - Heavy DOM</title>
  <style>
    body { margin: 0; font-family: sans-serif; background: #10141c; color: #e6edf3; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; padding: 12px; }
    .card {
      background: linear-gradient(135deg, #1b2230, #232d40);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; background: #2f81f7; font-size: 11px; }
  </style>
</head>
<body>
  <div id="grid" class="grid"></div>
  <script>
    const grid = document.getElementById("grid");
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 2500; i++) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = '<div class="badge">#' + i + '</div><div>Item ' + (i * 7 % 997) + '</div>';
      frag.appendChild(card);
    }
    grid.appendChild(frag);
    // Force layout
    const h = grid.getBoundingClientRect().height;
    window.addEventListener("load", () => {
      const loadWall = Date.now();
      const loadPerf = performance.now();
      requestAnimationFrame(() => {
        fetch("/beacon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "heavy",
            gridHeight: h,
            loadWallMs: loadWall,
            paintWallMs: Date.now(),
            loadPerfMs: loadPerf,
            paintPerfMs: performance.now()
          })
        });
      });
    });
  </script>
</body>
</html>`;
}

function htmlEngineBench() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Forkit Bench - Engine</title>
  <style>
    body { margin: 0; background: #0d1117; color: #fff; font-family: monospace; }
    canvas { display: block; width: 640px; height: 360px; }
  </style>
</head>
<body>
  <canvas id="c" width="640" height="360"></canvas>
  <div id="sandbox"></div>
  <script>
    function runJsCompute() {
      const t0 = performance.now();
      // 1. Prime sieve up to 200_000
      const limit = 200000;
      const sieve = new Uint8Array(limit + 1);
      let primes = 0;
      for (let i = 2; i <= limit; i++) {
        if (!sieve[i]) {
          primes++;
          for (let j = i * 2; j <= limit; j += i) sieve[j] = 1;
        }
      }
      // 2. Sort 50k floats
      const arr = new Float64Array(50000);
      for (let i = 0; i < arr.length; i++) arr[i] = ((i * 1103515245 + 12345) >>> 0) / 4294967296;
      arr.sort();
      // 3. JSON roundtrip 100x
      const sample = { items: Array.from({ length: 200 }, (_, k) => ({ id: k, tag: "t" + k, ok: k % 2 === 0 })) };
      let len = 0;
      for (let i = 0; i < 100; i++) {
        const s = JSON.stringify(sample);
        const p = JSON.parse(s);
        len += p.items.length;
      }
      return { ms: performance.now() - t0, primes, len };
    }

    function runDomStress() {
      const box = document.getElementById("sandbox");
      const t0 = performance.now();
      for (let i = 0; i < 3000; i++) {
        const el = document.createElement("div");
        el.textContent = "row-" + i;
        el.style.padding = (i % 5) + "px";
        box.appendChild(el);
        if (i % 100 === 0) void box.offsetHeight;
      }
      const mid = box.children.length;
      box.textContent = "";
      return { ms: performance.now() - t0, nodes: mid };
    }

    function runCanvasFps() {
      return new Promise((resolve) => {
        const canvas = document.getElementById("c");
        const ctx = canvas.getContext("2d");
        const balls = Array.from({ length: 200 }, (_, i) => ({
          x: (i * 37) % 640,
          y: (i * 53) % 360,
          vx: ((i % 5) + 1) * (i % 2 ? 1 : -1),
          vy: ((i % 4) + 1) * (i % 3 ? 1 : -1),
        }));
        const frameDeltas = [];
        let last = performance.now();
        let frames = 0;
        const maxFrames = 90;

        function step(now) {
          frameDeltas.push(now - last);
          last = now;
          ctx.fillStyle = "#0d1117";
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = "#58a6ff";
          for (const b of balls) {
            b.x += b.vx; b.y += b.vy;
            if (b.x < 0 || b.x > 640) b.vx *= -1;
            if (b.y < 0 || b.y > 360) b.vy *= -1;
            ctx.fillRect(b.x, b.y, 4, 4);
          }
          frames++;
          if (frames < maxFrames) {
            requestAnimationFrame(step);
          } else {
            const deltas = frameDeltas.slice(1); // skip first frame delta
            const totalMs = deltas.reduce((a, b) => a + b, 0);
            const sorted = [...deltas].sort((a, b) => a - b);
            const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
            const avgFrameMs = totalMs / Math.max(1, deltas.length);
            const fps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;
            resolve({ fps, avgFrameMs, p95FrameMs: p95, frames: deltas.length });
          }
        }
        requestAnimationFrame(step);
      });
    }

    window.addEventListener("load", async () => {
      const js = runJsCompute();
      const dom = runDomStress();
      const canvas = await runCanvasFps();
      fetch("/beacon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "engine", js, dom, canvas })
      });
    });
  </script>
</body>
</html>`;
}

function htmlAdblockStress() {
  const trackers = [
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
    "https://doubleclick.net/pixel.gif",
    "https://googleads.g.doubleclick.net/pagead/id",
    "https://www.google-analytics.com/analytics.js",
    "https://www.googletagmanager.com/gtm.js",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://ads.yahoo.com/pixel",
    "https://adservice.google.com/adsid/integrator.js",
    "https://static.ads-twitter.com/uwt.js",
    "https://bat.bing.com/bat.js",
  ];
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Forkit Bench - AdBlocker</title></head>
<body>
  <h1>AdBlock Stress</h1>
  <script>
    const trackers = ${JSON.stringify(trackers)};
    const t0 = performance.now();
    let settled = 0;
    let fastRejected = 0;
    const total = 50;
    let sent = false;

    function finish() {
      if (sent) return;
      sent = true;
      fetch("/beacon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "adblock",
          total,
          settled,
          fastRejected,
          elapsedMs: performance.now() - t0,
          paintWallMs: Date.now()
        })
      });
    }

    for (let i = 0; i < total; i++) {
      const url = trackers[i % trackers.length] + "?cb=" + i;
      const reqStart = performance.now();
      const img = new Image();
      const onDone = () => {
        if (performance.now() - reqStart < 150) fastRejected++;
        settled++;
        if (settled >= total) finish();
      };
      img.onload = onDone;
      img.onerror = onDone;
      img.src = url;
    }
    setTimeout(finish, 2000);
  </script>
</body>
</html>`;
}

// --- Server & Runner ---

function startBenchServer() {
  let activeRun = null;

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, "http://127.0.0.1");

    if (req.method === "POST" && urlObj.pathname === "/beacon") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        try {
          const data = JSON.parse(body);
          if (activeRun) activeRun.onBeacon(data);
        } catch {}
      });
      return;
    }

    if (activeRun && activeRun.firstHttpPerfMs === null) {
      activeRun.firstHttpPerfMs = performance.now();
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });

    if (urlObj.pathname === "/startup.html") {
      res.end(htmlStartup("startup"));
    } else if (urlObj.pathname === "/tab.html") {
      const id = urlObj.searchParams.get("id") || "0";
      res.end(htmlStartup(`tab-${id}`));
    } else if (urlObj.pathname === "/heavy.html") {
      res.end(htmlHeavyDom());
    } else if (urlObj.pathname === "/engine.html") {
      res.end(htmlEngineBench());
    } else if (urlObj.pathname === "/adblock.html") {
      res.end(htmlAdblockStress());
    } else {
      res.end(htmlStartup("default"));
    }
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          resolve(`http://127.0.0.1:${port}`);
        });
      }),
    setActiveRun: (run) => {
      activeRun = run;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function runForkitScenario(binPath, benchServer, urls, expectedBeacons, timeoutMs) {
  const beacons = [];
  let resolveWait;
  let rejectWait;

  const donePromise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const runState = {
    firstHttpPerfMs: null,
    onBeacon: (data) => {
      beacons.push({ ...data, receivedPerfMs: performance.now(), receivedWallMs: Date.now() });
      if (beacons.length >= expectedBeacons) {
        resolveWait();
      }
    },
  };
  benchServer.setActiveRun(runState);

  const spawnWallMs = Date.now();
  const spawnPerfMs = performance.now();

  const child = spawn(binPath, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORKIT_BENCH_URLS: urls.join(","),
    },
    stdio: "ignore",
    detached: false,
  });

  const timer = setTimeout(() => {
    rejectWait(
      new Error(
        `Zaman aşımı (${timeoutMs} ms): ${expectedBeacons} beacon bekleniyordu, ${beacons.length} geldi.`
      )
    );
  }, timeoutMs);

  child.once("exit", (code) => {
    if (beacons.length < expectedBeacons) {
      rejectWait(new Error(`Forkit erken kapandı (exit=${code}).`));
    }
  });

  let mem = { processCount: 0, pssMb: 0, rssMb: 0, privMb: 0 };
  try {
    await donePromise;
    mem = measureTree(child.pid);
  } finally {
    clearTimeout(timer);
    benchServer.setActiveRun(null);
    killTree(child.pid);
    await sleep(500);
  }

  return {
    spawnWallMs,
    spawnPerfMs,
    firstHttpMs:
      runState.firstHttpPerfMs !== null
        ? Math.max(0, runState.firstHttpPerfMs - spawnPerfMs)
        : null,
    beacons,
    mem,
  };
}

async function runIdleScenario(binPath, urls, waitMs) {
  const child = spawn(binPath, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORKIT_BENCH_URLS: urls.join(","),
    },
    stdio: "ignore",
    detached: false,
  });

  try {
    await sleep(waitMs);
    return measureTree(child.pid);
  } finally {
    killTree(child.pid);
    await sleep(500);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("DISPLAY veya WAYLAND_DISPLAY bulunamadı; grafik oturumunda çalıştırın.");
    process.exit(1);
  }

  const binPath = resolveBinary(opts.build);
  const benchServer = startBenchServer();
  const baseUrl = await benchServer.listen();

  console.log(
    `Forkit Hız Benchmark | Binary: ${path.relative(ROOT, binPath)} | CPU: ${os.cpus()[0]?.model || "unknown"} (${os.cpus().length} çekirdek) | Tekrar: ${opts.runs}`
  );

  const summaryRows = [];
  const rawReport = {
    timestamp: new Date().toISOString(),
    binary: path.relative(ROOT, binPath),
    cpu: os.cpus()[0]?.model || "unknown",
    cores: os.cpus().length,
    runs: opts.runs,
    scenarios: {},
  };

  try {
    // 1. Cold Startup + First Paint
    console.log(`\n▶ Senaryo 1: Soğuk Başlatma & İlk Boyama (${opts.runs} tekrar)`);
    const startupRuns = [];
    for (let i = 1; i <= opts.runs; i++) {
      const res = await runForkitScenario(
        binPath,
        benchServer,
        [`${baseUrl}/startup.html?run=${i}`],
        1,
        opts.timeoutMs
      );
      const b = res.beacons[0];
      const coldDcl = Math.max(0, b.dclWallMs - res.spawnWallMs);
      const coldLoad = Math.max(0, b.loadWallMs - res.spawnWallMs);
      const coldPaint = Math.max(0, b.paintWallMs - res.spawnWallMs);
      startupRuns.push({
        firstHttpMs: res.firstHttpMs ?? 0,
        coldDclMs: coldDcl,
        coldLoadMs: coldLoad,
        coldPaintMs: coldPaint,
        inPageLoadMs: b.loadPerfMs,
        pssMb: res.mem.pssMb,
      });
      console.log(
        `  [Tekrar ${i}/${opts.runs}] İlk HTTP: ${fmtMs(res.firstHttpMs ?? 0)} | DCL: ${fmtMs(coldDcl)} | Load: ${fmtMs(coldLoad)} | İlk Kare (rAF): ${fmtMs(coldPaint)} | Sayfa İçi: ${fmtMs(b.loadPerfMs)} | RAM (PSS): ${res.mem.pssMb.toFixed(1)} MB`
      );
    }

    const paintStats = stats(startupRuns.map((r) => r.coldPaintMs));
    const httpStats = stats(startupRuns.map((r) => r.firstHttpMs));
    const inPageStats = stats(startupRuns.map((r) => r.inPageLoadMs));
    const startupPssStats = stats(startupRuns.map((r) => r.pssMb));

    rawReport.scenarios.coldStartup = { runs: startupRuns, paintStats, httpStats, inPageStats, startupPssStats };
    summaryRows.push({
      Senaryo: "1. Soğuk Başlatma -> İlk HTTP",
      "Medyan / Değer": fmtMs(httpStats.median),
      "Min": fmtMs(httpStats.min),
      "Maks": fmtMs(httpStats.max),
      "RAM (PSS)": `${startupPssStats.median.toFixed(1)} MB`,
    });
    summaryRows.push({
      Senaryo: "1. Soğuk Başlatma -> İlk Kare (rAF)",
      "Medyan / Değer": fmtMs(paintStats.median),
      "Min": fmtMs(paintStats.min),
      "Maks": fmtMs(paintStats.max),
      "RAM (PSS)": `${startupPssStats.median.toFixed(1)} MB`,
    });

    // 2. Heavy DOM + Layout
    console.log("\n▶ Senaryo 2: Ağır DOM & CSS Yükleme (2.500 kart + zorunlu layout)");
    const heavyRes = await runForkitScenario(
      binPath,
      benchServer,
      [`${baseUrl}/heavy.html`],
      1,
      opts.timeoutMs
    );
    const hb = heavyRes.beacons[0];
    const heavyColdPaint = Math.max(0, hb.paintWallMs - heavyRes.spawnWallMs);
    console.log(
      `  Soğuk -> İlk Kare: ${fmtMs(heavyColdPaint)} | Sayfa İçi Yükleme: ${fmtMs(hb.loadPerfMs)} | Sayfa İçi rAF: ${fmtMs(hb.paintPerfMs)}`
    );
    rawReport.scenarios.heavyDom = {
      coldPaintMs: heavyColdPaint,
      inPageLoadMs: hb.loadPerfMs,
      inPagePaintMs: hb.paintPerfMs,
    };
    summaryRows.push({
      Senaryo: "2. Ağır DOM (2.500 öğe, sayfa içi)",
      "Medyan / Değer": fmtMs(hb.paintPerfMs),
      "Min": "-",
      "Maks": "-",
      "RAM (PSS)": `${heavyRes.mem.pssMb.toFixed(1)} MB`,
    });

    // 3. Multi-Tab Parallel Load (5 Tabs)
    console.log("\n▶ Senaryo 3: Çoklu Sekme Paralel Yükleme (5 sekme)");
    const tabUrls = Array.from({ length: 5 }, (_, i) => `${baseUrl}/tab.html?id=${i + 1}`);
    const multiRes = await runForkitScenario(
      binPath,
      benchServer,
      tabUrls,
      5,
      opts.timeoutMs
    );
    const tabPaints = multiRes.beacons.map((b) => Math.max(0, b.paintWallMs - multiRes.spawnWallMs));
    const firstTabMs = Math.min(...tabPaints);
    const allTabsMs = Math.max(...tabPaints);
    const perExtraTabMs = Math.max(0, (allTabsMs - paintStats.median) / 4);
    const perExtraTabMb = Math.max(0, (multiRes.mem.pssMb - startupPssStats.median) / 4);
    console.log(
      `  İlk Sekme Hazır: ${fmtMs(firstTabMs)} | Tüm 5 Sekme Hazır: ${fmtMs(allTabsMs)} | Ek Sekme Başına: ~${fmtMs(perExtraTabMs)} / ~${perExtraTabMb.toFixed(1)} MB | Toplam PSS: ${multiRes.mem.pssMb.toFixed(1)} MB (${multiRes.mem.processCount} süreç)`
    );
    rawReport.scenarios.multiTab5 = {
      firstTabMs,
      allTabsMs,
      tabPaints,
      perExtraTabMs,
      perExtraTabMb,
      mem: multiRes.mem,
    };
    summaryRows.push({
      Senaryo: "3. 5 Sekme Paralel (Tümü Hazır)",
      "Medyan / Değer": fmtMs(allTabsMs),
      "Min": fmtMs(firstTabMs),
      "Maks": fmtMs(allTabsMs),
      "RAM (PSS)": `${multiRes.mem.pssMb.toFixed(1)} MB`,
    });

    // 4. WebKit Engine Micro-Benchmarks (JS + DOM + Canvas FPS)
    console.log("\n▶ Senaryo 4: WebKit Motor Hızı (JS + DOM + Canvas 2D FPS)");
    const engRes = await runForkitScenario(
      binPath,
      benchServer,
      [`${baseUrl}/engine.html`],
      1,
      opts.timeoutMs
    );
    const eb = engRes.beacons[0];
    console.log(
      `  JS Hesaplama (Sieve+Sort+JSON): ${fmtMs(eb.js.ms)}`
    );
    console.log(
      `  DOM Stres (3.000 düğüm): ${fmtMs(eb.dom.ms)}`
    );
    console.log(
      `  Canvas 2D Animasyon: ${eb.canvas.fps.toFixed(1)} FPS (Ort. Kare: ${fmtMs(eb.canvas.avgFrameMs)}, P95: ${fmtMs(eb.canvas.p95FrameMs)})`
    );
    rawReport.scenarios.engine = { js: eb.js, dom: eb.dom, canvas: eb.canvas, mem: engRes.mem };
    summaryRows.push({
      Senaryo: "4a. Motor: JS Hesaplama",
      "Medyan / Değer": fmtMs(eb.js.ms),
      "Min": "-",
      "Maks": "-",
      "RAM (PSS)": "-",
    });
    summaryRows.push({
      Senaryo: "4b. Motor: DOM Stres (3.000 düğüm)",
      "Medyan / Değer": fmtMs(eb.dom.ms),
      "Min": "-",
      "Maks": "-",
      "RAM (PSS)": "-",
    });
    summaryRows.push({
      Senaryo: "4c. Motor: Canvas 2D FPS",
      "Medyan / Değer": `${eb.canvas.fps.toFixed(1)} FPS`,
      "Min": "-",
      "Maks": `P95 ${fmtMs(eb.canvas.p95FrameMs)}`,
      "RAM (PSS)": `${engRes.mem.pssMb.toFixed(1)} MB`,
    });

    // 5. AdBlocker Overhead
    console.log("\n▶ Senaryo 5: AdBlocker Tepki Süresi (50 izleyici isteği)");
    const adRes = await runForkitScenario(
      binPath,
      benchServer,
      [`${baseUrl}/adblock.html`],
      1,
      opts.timeoutMs
    );
    const ab = adRes.beacons[0];
    console.log(
      `  Tamamlanan: ${ab.settled}/${ab.total} | Hızlı Red (<150ms): ${ab.fastRejected} | Süre: ${fmtMs(ab.elapsedMs)}`
    );
    rawReport.scenarios.adblock = ab;
    summaryRows.push({
      Senaryo: "5. AdBlocker (50 izleyici isteği)",
      "Medyan / Değer": fmtMs(ab.elapsedMs),
      "Min": `${ab.fastRejected}/${ab.total} hızlı red`,
      "Maks": "-",
      "RAM (PSS)": `${adRes.mem.pssMb.toFixed(1)} MB`,
    });

    // 6. newtab.html Idle RAM & Process Footprint
    console.log("\n▶ Senaryo 6: newtab.html Boşta Bellek (2s bekleme)");
    const newtabMem = await runIdleScenario(binPath, ["newtab.html"], 2000);
    console.log(
      `  Süreç: ${newtabMem.processCount} | PSS: ${newtabMem.pssMb.toFixed(1)} MB | Private: ${newtabMem.privMb.toFixed(1)} MB | RSS: ${newtabMem.rssMb.toFixed(1)} MB`
    );
    rawReport.scenarios.newtabIdle = newtabMem;
    summaryRows.push({
      Senaryo: "6. newtab.html (Boşta @ 2s)",
      "Medyan / Değer": `${newtabMem.processCount} süreç`,
      "Min": `Priv ${newtabMem.privMb.toFixed(1)} MB`,
      "Maks": `RSS ${newtabMem.rssMb.toFixed(1)} MB`,
      "RAM (PSS)": `${newtabMem.pssMb.toFixed(1)} MB`,
    });

    console.log("\n=== HIZ BENCHMARK ÖZETİ ===");
    console.table(summaryRows);

    if (opts.outFile) {
      const targetPath = path.resolve(ROOT, opts.outFile);
      fs.writeFileSync(targetPath, JSON.stringify(rawReport, null, 2));
      console.log(`\nJSON raporu kaydedildi: ${targetPath}`);
    }
  } finally {
    await benchServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
