#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_BIN = path.join(ROOT, "src-tauri", "target", "release", "forkit");
const DEBUG_BIN = path.join(ROOT, "src-tauri", "target", "debug", "forkit");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTotalSystemRamMb() {
  const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
  const match = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) / 1024 : 0;
}

function listAllProcesses() {
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
  const tree = getProcessTreePids(rootPid);
  const byType = new Map();
  let totalPssKb = 0;
  let totalRssKb = 0;
  let totalPrivKb = 0;

  for (const p of tree) {
    const m = readSmapsRollupKb(p.pid);
    totalPssKb += m.pss;
    totalRssKb += m.rss;
    totalPrivKb += m.priv;
    const prev = byType.get(p.comm) || { count: 0, pssKb: 0, rssKb: 0, privKb: 0 };
    prev.count += 1;
    prev.pssKb += m.pss;
    prev.rssKb += m.rss;
    prev.privKb += m.priv;
    byType.set(p.comm, prev);
  }

  return {
    processCount: tree.length,
    pssMb: totalPssKb / 1024,
    rssMb: totalRssKb / 1024,
    privMb: totalPrivKb / 1024,
    byType: Object.fromEntries(byType.entries()),
  };
}

function killTree(rootPid) {
  const tree = getProcessTreePids(rootPid);
  for (const p of tree.reverse()) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {}
  }
}

function resolveBinary() {
  if (process.argv.includes("--build") || (!fs.existsSync(RELEASE_BIN) && !fs.existsSync(DEBUG_BIN))) {
    console.log("Building release binary for accurate benchmark...");
    execFileSync("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
  if (fs.existsSync(RELEASE_BIN)) return RELEASE_BIN;
  return DEBUG_BIN;
}

async function runScenario(binPath, name, urls, checkpointsSec) {
  console.log(`\n▶ Senaryo: ${name}`);
  const env = { ...process.env };
  if (urls.length > 0) {
    env.FORKIT_BENCH_URLS = urls.join(",");
  } else {
    delete env.FORKIT_BENCH_URLS;
  }

  const child = spawn(binPath, [], {
    cwd: ROOT,
    env,
    stdio: "ignore",
    detached: false,
  });

  const totalRamMb = getTotalSystemRamMb();
  const snapshots = [];
  let elapsed = 0;

  try {
    for (const cp of checkpointsSec) {
      const waitSec = cp.atSec - elapsed;
      if (waitSec > 0) {
        await sleep(waitSec * 1000);
        elapsed = cp.atSec;
      }
      const stats = measureTree(child.pid);
      const pct = totalRamMb > 0 ? (stats.pssMb / totalRamMb) * 100 : 0;
      snapshots.push({ label: cp.label, atSec: cp.atSec, pct, ...stats });
      console.log(
        `  [${cp.label} @ ${cp.atSec}s] Süreç: ${stats.processCount} | PSS: ${stats.pssMb.toFixed(1)} MB (${pct.toFixed(2)}%) | RSS: ${stats.rssMb.toFixed(1)} MB | Private: ${stats.privMb.toFixed(1)} MB`
      );
      for (const [comm, info] of Object.entries(stats.byType)) {
        console.log(
          `    - ${comm} (x${info.count}): PSS ${(info.pssKb / 1024).toFixed(1)} MB, Private ${(info.privKb / 1024).toFixed(1)} MB`
        );
      }
    }
  } finally {
    killTree(child.pid);
    await sleep(800);
  }

  return snapshots;
}

async function main() {
  if (process.platform !== "linux") {
    console.error("Bu benchmark Linux /proc/smaps_rollup gerektirir.");
    process.exit(1);
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("DISPLAY veya WAYLAND_DISPLAY bulunamadı; grafik oturumunda çalıştırın.");
    process.exit(1);
  }

  const binPath = resolveBinary();
  const totalRamMb = getTotalSystemRamMb();
  console.log(`Forkit RAM Benchmark | Binary: ${path.relative(ROOT, binPath)} | Sistem RAM: ${(totalRamMb / 1024).toFixed(1)} GB`);

  const results = [];
  results.push(...(await runScenario(binPath, "1. Boşta (1x newtab.html)", [], [{ label: "Boşta", atSec: 6 }])));
  results.push(
    ...(await runScenario(
      binPath,
      "2. YouTube Video Oynatımı (1x YouTube)",
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      [{ label: "YouTube Video", atSec: 15 }]
    ))
  );
  results.push(
    ...(await runScenario(
      binPath,
      "3. 3 Sekme (newtab + example.com + YouTube)",
      ["newtab.html", "https://example.com", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      [
        { label: "3 Sekme (Aktif)", atSec: 15 },
        { label: "3 Sekme (Uyutma Sonrası)", atSec: 65 },
      ]
    ))
  );

  console.log("\n=== ÖZET TABLO ===");
  console.table(
    results.map((r) => ({
      Senaryo: r.label,
      Surec: r.processCount,
      "PSS (MB)": Number(r.pssMb.toFixed(1)),
      "Private (MB)": Number(r.privMb.toFixed(1)),
      "RSS (MB)": Number(r.rssMb.toFixed(1)),
      "RAM %": Number(r.pct.toFixed(2)),
    }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
