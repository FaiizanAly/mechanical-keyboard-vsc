import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ─── State ────────────────────────────────────────────────────────────────────
let isEnabled       = true;
let volume          = 0.8;
let soundsDir       = '';
let statusBarItem:  vscode.StatusBarItem;
let lastChangeTime  = 0;
const MIN_INTERVAL_MS = 20; // Human typing rate limit (max 50 events/sec)
const platform      = os.platform();

// ─── Windows: persistent PowerShell worker ────────────────────────────────────
let psWorker: ChildProcess | null = null;
let psReady         = false;
let psScript        = '';
let isDeactivated   = false;
let psRespawnTimer: NodeJS.Timeout | null = null;

function initWindowsWorker(): void {
  if (psWorker || isDeactivated) return;

  try {
    psWorker = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-File', psScript,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    );

    psWorker.on('exit', () => {
      psWorker = null;
      psReady  = false;
      // Do not respawn if the extension is deactivating or closing
      if (!isDeactivated) {
        psRespawnTimer = setTimeout(initWindowsWorker, 2000);
      }
    });

    psWorker.on('error', () => {
      psWorker = null;
      psReady  = false;
    });

    // Give PowerShell ~800 ms to load .NET assemblies, then mark ready
    setTimeout(() => {
      if (!isDeactivated && psWorker) {
        psReady = true;
      }
    }, 800);
  } catch (err) {
    console.error('[MechanicalVSC] Failed to start PS worker:', err);
  }
}

// ─── Sound categories ─────────────────────────────────────────────────────────
const SPECIAL_SOUNDS: Record<string, string> = {
  '\n':   'enter',
  '\r':   'enter',
  '\r\n': 'enter',
  ' ':    'space',
  '\t':   'tab',
};
const KEY_POOL = ['a', 'b', 'c', 'd', 'e', 'f'];

// ─── Process & Resource Management ───────────────────────────────────────────
// Cap concurrent audio processes to avoid sound clipping and CPU bursts
const MAX_CONCURRENT_PROCS = 6;
const activeProcs = new Set<ChildProcess>();

function playSound(soundName: string): void {
  if (!isEnabled || volume <= 0) return;

  const filePath = path.join(soundsDir, `${soundName}.wav`);
  const target   = fs.existsSync(filePath) ? filePath : path.join(soundsDir, 'a.wav');
  if (!fs.existsSync(target)) return;

  if (platform === 'darwin') {
    playMac(target);
  } else if (platform === 'win32') {
    playWindows(target);
  } else {
    playLinux(target);
  }
}

// ── macOS Playback ────────────────────────────────────────────────────────────
function playMac(filePath: string): void {
  // If already at concurrency limit, drop excess to prevent process spikes
  if (activeProcs.size >= MAX_CONCURRENT_PROCS) return;

  try {
    const proc = spawn('afplay', ['-v', volume.toFixed(2), filePath], {
      detached: true,
      stdio:    'ignore',
    });
    proc.unref();

    activeProcs.add(proc);
    const cleanup = () => activeProcs.delete(proc);
    proc.on('close', cleanup);
    proc.on('error', cleanup);
    proc.on('exit',  cleanup);
  } catch (err) {
    console.error('[MechanicalVSC] afplay error:', err);
  }
}

// ── Windows Playback ──────────────────────────────────────────────────────────
function playWindows(filePath: string): void {
  if (psWorker && psReady && psWorker.stdin && !psWorker.killed) {
    try {
      psWorker.stdin.write(filePath + '\n');
    } catch {
      // Worker stdin closed; ignore safely
    }
  }
}

// ── Linux Playback ────────────────────────────────────────────────────────────
let linuxPlayer: string | null = null;
function detectLinuxPlayer(): void {
  for (const cmd of ['paplay', 'aplay', 'ffplay']) {
    try {
      const r = require('child_process').spawnSync('which', [cmd]);
      if (r.status === 0) {
        linuxPlayer = cmd;
        return;
      }
    } catch {}
  }
}

function playLinux(filePath: string): void {
  if (!linuxPlayer || activeProcs.size >= MAX_CONCURRENT_PROCS) return;

  try {
    const args = linuxPlayer === 'paplay'
      ? ['--volume', String(Math.round(volume * 65536)), filePath]
      : ['--quiet', filePath];

    const proc = spawn(linuxPlayer, args, { detached: true, stdio: 'ignore' });
    proc.unref();

    activeProcs.add(proc);
    const cleanup = () => activeProcs.delete(proc);
    proc.on('close', cleanup);
    proc.on('error', cleanup);
    proc.on('exit',  cleanup);
  } catch (err) {
    console.error('[MechanicalVSC] Linux audio error:', err);
  }
}

// ─── Extension Entry Point ───────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  soundsDir = path.join(context.extensionPath, 'sounds');
  psScript  = path.join(context.extensionPath, 'audio-server.ps1');

  // Load user settings
  const cfg = vscode.workspace.getConfiguration('aulaF75');
  isEnabled = cfg.get<boolean>('enabled', true);
  volume    = cfg.get<number>('volume', 0.8);

  // Initialize platform audio subsystems
  if (platform === 'win32') {
    initWindowsWorker();
  } else if (platform === 'linux') {
    detectLinuxPlayer();
  }

  // ── Status Bar ──────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBarItem.command = 'aulaF75.toggle';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  // ── Keystroke Listener (Protected against formatters, git, and leaks) ────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isEnabled || volume <= 0) return;

      // 1. Only listen to focused, real code editor documents
      const editor = vscode.window.activeTextEditor;
      if (!editor || event.document !== editor.document) return;

      // 2. Ignore non-code virtual documents (output channels, git diffs, debug logs)
      const scheme = event.document.uri.scheme;
      if (scheme !== 'file' && scheme !== 'untitled' && scheme !== 'vscode-notebook-cell') {
        return;
      }

      // 3. Ignore Undo / Redo operations (not human key typing)
      if (event.reason !== undefined) return;

      // 4. Ignore automated edits, code formatting, refactoring (bulk changes)
      if (event.contentChanges.length === 0 || event.contentChanges.length > 3) return;

      // 5. Rate limit typing events (debouncing against synthetic automation)
      const now = Date.now();
      if (now - lastChangeTime < MIN_INTERVAL_MS) return;
      lastChangeTime = now;

      // 6. Inspect the first keystroke change
      for (const change of event.contentChanges) {
        const text = change.text;

        // Backspace / delete key
        if (text === '' && change.rangeLength > 0) {
          playSound('backspace');
          return;
        }

        // Ignore large pastes / code snippets
        if (text.length > 2) continue;

        // Special keys (Enter, Space, Tab)
        const special = SPECIAL_SOUNDS[text];
        if (special) {
          playSound(special);
          return;
        }

        // Standard keystroke: pick random switch variation for natural feel
        const soundKey = KEY_POOL[Math.floor(Math.random() * KEY_POOL.length)];
        playSound(soundKey);
        return;
      }
    })
  );

  // ── Commands ────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aulaF75.toggle', () => {
      isEnabled = !isEnabled;
      vscode.workspace.getConfiguration('aulaF75').update('enabled', isEnabled, true);
      updateStatusBar();
      vscode.window.showInformationMessage(
        isEnabled ? 'Mechanical VSC: Sounds ON' : 'Mechanical VSC: Sounds OFF'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aulaF75.setVolume', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Set volume (0.0 – 1.0)',
        value:  String(volume),
        validateInput: (v) => {
          const n = parseFloat(v);
          return isNaN(n) || n < 0 || n > 1 ? 'Enter a number between 0.0 and 1.0' : null;
        },
      });
      if (input !== undefined) {
        volume = parseFloat(input);
        vscode.workspace.getConfiguration('aulaF75').update('volume', volume, true);
        vscode.window.showInformationMessage(
          `Mechanical VSC: Volume set to ${Math.round(volume * 100)}%`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aulaF75.showStatus', () => {
      const platMap: Record<string, string> = {
        darwin: 'macOS (afplay)',
        win32:  'Windows (PS worker)',
        linux:  `Linux (${linuxPlayer ?? 'none'})`,
      };
      const plat = platMap[platform] ?? platform;
      vscode.window.showInformationMessage(
        `Mechanical VSC | ${isEnabled ? 'Active' : 'Off'} | Volume: ${Math.round(volume * 100)}% | Engine: ${plat}`
      );
    })
  );

  // ── Configuration Sync ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aulaF75')) {
        const c = vscode.workspace.getConfiguration('aulaF75');
        isEnabled = c.get<boolean>('enabled', true);
        volume    = c.get<number>('volume', 0.8);
        updateStatusBar();
      }
    })
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function updateStatusBar() {
  if (!statusBarItem) return;
  statusBarItem.text    = isEnabled ? '$(unmute) Mech VSC' : '$(mute) Mech VSC';
  statusBarItem.tooltip = isEnabled
    ? 'Mechanical VSC: Sounds ON (click to mute)'
    : 'Mechanical VSC: Sounds OFF (click to unmute)';
  statusBarItem.backgroundColor = isEnabled
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

// ─── Clean Unload ─────────────────────────────────────────────────────────────
export function deactivate() {
  isDeactivated = true;

  if (psRespawnTimer) {
    clearTimeout(psRespawnTimer);
    psRespawnTimer = null;
  }

  // Gracefully terminate Windows background worker
  if (psWorker) {
    try { psWorker.stdin?.write('EXIT\n'); } catch {}
    try { psWorker.stdin?.end(); } catch {}
    const workerRef = psWorker;
    psWorker = null;
    setTimeout(() => {
      try { workerRef.kill(); } catch {}
    }, 150);
  }

  // Terminate any active audio player child processes
  for (const proc of activeProcs) {
    try { proc.kill(); } catch {}
  }
  activeProcs.clear();

  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
