import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ─── State ────────────────────────────────────────────────────────────────────
let isEnabled    = true;
let volume       = 0.8;
let soundsDir    = '';
let statusBarItem: vscode.StatusBarItem;
let lastChangeTime = 0;
const MIN_INTERVAL_MS = 15;
const platform = os.platform();

// ─── Windows: persistent PowerShell worker ────────────────────────────────────
let psWorker: ChildProcess | null = null;
let psReady   = false;
let psScript  = '';

function initWindowsWorker(): void {
  if (psWorker) return;

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

    psWorker.on('exit', (code) => {
      console.log('[MechanicalVSC] PS worker exited, code:', code, '— respawning…');
      psWorker = null;
      psReady  = false;
      // Respawn after short delay so we don't tight-loop on repeated failures
      setTimeout(initWindowsWorker, 1500);
    });

    psWorker.on('error', (err) => {
      console.error('[MechanicalVSC] PS worker error:', err.message);
      psWorker = null;
      psReady  = false;
    });

    // Give PowerShell ~800 ms to load .NET assemblies, then mark ready
    setTimeout(() => { psReady = true; }, 800);

    console.log('[MechanicalVSC] Windows PS worker started (PID', psWorker.pid, ')');
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

// macOS: track child procs for cleanup
const activeProcs = new Set<ChildProcess>();

// ─── Core playback router ─────────────────────────────────────────────────────
function playSound(soundName: string): void {
  if (!isEnabled) return;

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

// ── macOS ──────────────────────────────────────────────────────────────────────
// afplay is Apple's built-in CLI player. Each call spawns a tiny native process
// (~15 ms overhead). Multiple calls run in parallel giving free polyphony.
function playMac(filePath: string): void {
  try {
    const proc = spawn('afplay', ['-v', volume.toFixed(2), filePath], {
      detached: true,
      stdio:    'ignore',
    });
    proc.unref();
    activeProcs.add(proc);
    proc.on('close', () => activeProcs.delete(proc));
  } catch (err) {
    console.error('[MechanicalVSC] afplay error:', err);
  }
}

// ── Windows ────────────────────────────────────────────────────────────────────
// Send the path to the persistent PS worker over stdin.
// The worker's SoundPlayer pool handles polyphony internally.
// If the worker isn't ready yet (first ~800 ms), fall back to a one-off PS call.
function playWindows(filePath: string): void {
  if (psWorker && psReady && psWorker.stdin) {
    try {
      psWorker.stdin.write(filePath + '\n');
      return;
    } catch {
      // stdin may have closed — fall through to fallback
    }
  }

  // Fallback: one-off PowerShell (used only during the ~800 ms warmup window)
  try {
    const proc = spawn(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `[System.Media.SoundPlayer]::new('${filePath.replace(/\\/g, '\\\\')}').Play()`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    proc.unref();
  } catch (err) {
    console.error('[MechanicalVSC] Windows fallback error:', err);
  }
}

// ── Linux ──────────────────────────────────────────────────────────────────────
// Try paplay (PulseAudio) first; fall back to aplay (ALSA).
// Linux process spawn is fast enough (~5 ms) that per-sound spawning is fine.
function playLinux(filePath: string): void {
  // Detect available player once and cache it
  const player = detectLinuxPlayer();
  if (!player) return;

  try {
    const args = player === 'paplay'
      ? ['--volume', String(Math.round(volume * 65536)), filePath]
      : ['--quiet', filePath];

    const proc = spawn(player, args, { detached: true, stdio: 'ignore' });
    proc.unref();
  } catch (err) {
    console.error('[MechanicalVSC] Linux audio error:', err);
  }
}

let _linuxPlayer: string | null | undefined;
function detectLinuxPlayer(): string | null {
  if (_linuxPlayer !== undefined) return _linuxPlayer;
  for (const cmd of ['paplay', 'aplay', 'ffplay']) {
    try {
      const r = require('child_process').spawnSync('which', [cmd]);
      if (r.status === 0) { _linuxPlayer = cmd; return cmd; }
    } catch {}
  }
  _linuxPlayer = null;
  return null;
}

// ─── Extension Entry ──────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  soundsDir = path.join(context.extensionPath, 'sounds');
  psScript  = path.join(context.extensionPath, 'audio-server.ps1');

  // Load saved config
  const cfg = vscode.workspace.getConfiguration('aulaF75');
  isEnabled = cfg.get<boolean>('enabled', true);
  volume    = cfg.get<number>('volume', 0.8);

  // Start Windows PS worker eagerly so it's warm before first keystroke
  if (platform === 'win32') {
    initWindowsWorker();
  }

  // ── Status bar ─────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBarItem.command = 'aulaF75.toggle';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  // ── Keystroke listener ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isEnabled) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || event.document !== editor.document) return;

      const now = Date.now();
      if (now - lastChangeTime < MIN_INTERVAL_MS) return;
      lastChangeTime = now;

      for (const change of event.contentChanges) {
        const text = change.text;

        // Backspace / delete
        if (text === '' && change.rangeLength > 0) {
          playSound('backspace'); return;
        }
        // Skip bulk pastes / autocomplete / snippets
        if (text.length > 2) continue;

        // Special keys
        const special = SPECIAL_SOUNDS[text];
        if (special) { playSound(special); return; }

        // Regular key — random variant for natural feel
        playSound(KEY_POOL[Math.floor(Math.random() * KEY_POOL.length)]);
        return;
      }
    })
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aulaF75.toggle', () => {
      isEnabled = !isEnabled;
      vscode.workspace.getConfiguration('aulaF75').update('enabled', isEnabled, true);
      updateStatusBar();
      vscode.window.showInformationMessage(
        isEnabled ? '🎹 Mechanical VSC: Sounds ON' : '🔇 Mechanical VSC: Sounds OFF'
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
          `🔊 Mechanical VSC: Volume → ${Math.round(volume * 100)}%`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aulaF75.showStatus', () => {
      const platMap: Record<string, string> = { darwin: 'macOS (afplay)', win32: 'Windows (PS worker)', linux: 'Linux (paplay/aplay)' };
      const plat = platMap[platform] ?? platform;
      vscode.window.showInformationMessage(
        `Mechanical VSC  |  ${isEnabled ? '✅ Active' : '❌ Off'}  |  Volume: ${Math.round(volume * 100)}%  |  ${plat}`
      );
    })
  );

  // ── Config change listener ─────────────────────────────────────────────────
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

  console.log(`[MechanicalVSC] ✅ Active on ${platform}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function updateStatusBar() {
  statusBarItem.text    = isEnabled ? '$(unmute) Mech VSC' : '$(mute) Mech VSC';
  statusBarItem.tooltip = isEnabled
    ? 'Mechanical VSC: Sounds ON — click to toggle'
    : 'Mechanical VSC: Sounds OFF — click to toggle';
  statusBarItem.backgroundColor = isEnabled
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

export function deactivate() {
  // Shut down Windows PS worker cleanly
  if (psWorker) {
    try { psWorker.stdin?.write('EXIT\n'); } catch {}
    setTimeout(() => { try { psWorker?.kill(); } catch {} }, 300);
  }
  // Kill any lingering macOS afplay processes
  for (const proc of activeProcs) {
    try { proc.kill(); } catch {}
  }
  activeProcs.clear();
  statusBarItem?.dispose();
}
