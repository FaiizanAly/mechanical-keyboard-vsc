# Mechanical VSC (AULA F75)

> **Important Note:** This is **strictly a VS Code extension**, NOT a system-wide or native desktop app. Sounds will **only** play while you are typing inside VS Code / Cursor editors, not across other system apps or browsers.

Turn your VS Code into an authentic **AULA F75 mechanical keyboard** with satisfying, thocky **NK Cream linear switch** sounds on every keystroke with zero latency.

---

## How to Install

1. Download or locate `mechanical-vsc.vsix`.
2. **Drag & drop** the `.vsix` file into your VS Code **Extensions** panel (`Cmd+Shift+X` or `Ctrl+Shift+X`).
   * *Alternative:* Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows) → select **"Extensions: Install from VSIX..."** → choose `mechanical-vsc.vsix`.
3. Done! No restart required.

---

## How to Use

1. Open any file or create a new editor tab in VS Code.
2. Start typing.
3. Every keystroke produces real mechanical switch sounds with unique samples for:
   * **Regular letters & symbols** (random variations for natural typing)
   * **Spacebar** (deep stabilized thock)
   * **Enter** (satisfying return sound)
   * **Backspace** (crisp deletion click)

---

## How to Disable or Adjust

You can mute or customize sounds anytime:

* **Quick Toggle (1-Click):** Click the **`Mech VSC`** button in the bottom-right status bar.
* **Via Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):**
  * `AULA F75: Toggle Keyboard Sounds` — Mute or unmute
  * `AULA F75: Set Volume` — Adjust volume between `0.0` and `1.0` (default: `0.8`)
  * `AULA F75: Show Status` — Check audio engine status
* **In VS Code Settings (`Cmd+,` / `Ctrl+,`):**
  Search for `AULA F75` to toggle sounds or tweak settings permanently.

---

## How It Works

* **Keystroke Listener:** Uses VS Code's native `workspace.onDidChangeTextDocument` API to detect when you type inside an active editor.
* **Invisible & Zero Latency:** No pop-up tabs or heavy browser webviews. Audio is handled natively in the background:
  * **macOS:** Uses built-in `afplay` (~15ms response).
  * **Windows:** Uses a persistent pre-loaded background PowerShell worker with a 6-sound pool to allow fast, overlapping keystrokes without lag.
  * **Linux:** Uses `paplay` / `aplay`.

---

## License

MIT
