# audio-server.ps1
# Persistent audio worker for Mechanical VSC extension on Windows.
# Reads WAV file paths from stdin (one per line) and plays them
# immediately using a rotating pool of SoundPlayer instances (polyphony).

Add-Type -AssemblyName System.Windows.Forms

# Pool of 6 SoundPlayer objects — each plays independently, giving polyphony.
$POOL_SIZE = 6
$players = @()
for ($i = 0; $i -lt $POOL_SIZE; $i++) {
    $players += [System.Media.SoundPlayer]::new()
}
$idx = 0

while ($true) {
    try {
        $path = [Console]::ReadLine()
        # null means stdin was closed / extension deactivated — exit cleanly
        if ($null -eq $path) { break }
        $path = $path.Trim()
        if ($path.Length -eq 0) { continue }
        if ($path -eq 'EXIT') { break }

        # Assign file and play on the next slot in the pool
        $players[$idx].SoundLocation = $path
        $players[$idx].Play()          # async — returns immediately
        $idx = ($idx + 1) % $POOL_SIZE
    } catch {
        # Silently ignore any playback errors and keep running
    }
}

# Clean disposal of native Windows sound handles on exit
for ($i = 0; $i -lt $POOL_SIZE; $i++) {
    if ($players[$i]) {
        try { $players[$i].Dispose() } catch {}
    }
}
