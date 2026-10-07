# Generates the clean synthetic recordings described in manifest.json using Windows text-to-speech,
# then runs degrade.mjs to create the noisy / quiet / phone / echo / car / clipped variants.
# Output: accuracy/testset/synthetic/<id>.wav + <id>.ref.txt + <id>.meta.json  (git-ignored)
#
#   powershell -ExecutionPolicy Bypass -File accuracy/synthetic/generate.ps1
Add-Type -AssemblyName System.Speech
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
$out = Join-Path $root 'accuracy\testset\synthetic'
New-Item -ItemType Directory -Force $out | Out-Null
$manifest = Get-Content (Join-Path $here 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($item in $manifest.items) {
  $wav = Join-Path $out "$($item.id).wav"
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SetOutputToWaveFile($wav)
  $ref = @()
  $turns = @()
  foreach ($line in $item.lines) {
    $v = $manifest.voices.($line[0])
    # optional 3rd element: SSML for how it is spoken (pitch / volume / emphasis); the 2nd stays the reference text
    $text = if ($line.Count -ge 3) { $line[2] } else { [System.Security.SecurityElement]::Escape($line[1]) }
    $rate = switch ([int]$v.rate) { { $_ -ge 5 } { 'fast' } { $_ -le -2 } { 'slow' } default { 'medium' } }
    $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='$($v.voice)'><prosody pitch='$($v.pitch)' rate='$rate'>$text</prosody></voice></speak>"
    $s.SpeakSsml($ssml)
    $ref += $line[1]
    $turns += [ordered]@{ speaker = $line[0]; text = $line[1] }
  }
  $s.Dispose()
  [IO.File]::WriteAllText((Join-Path $out "$($item.id).ref.txt"), ($ref -join "`n"), (New-Object Text.UTF8Encoding $false))
  # who said what, for word-level speaker attribution scoring
  [IO.File]::WriteAllText((Join-Path $out "$($item.id).turns.json"), (ConvertTo-Json -InputObject @($turns) -Depth 3), (New-Object Text.UTF8Encoding $false))
  $meta = [ordered]@{ category = $item.category; speakers = $item.speakers; language = 'en'; synthetic = $true }
  if ($item.vocabulary) { $meta.vocabulary = $item.vocabulary }
  if ($item.boundaryTest) { $meta.boundaryTest = $true }
  [IO.File]::WriteAllText((Join-Path $out "$($item.id).meta.json"), ($meta | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  Write-Output "wrote $($item.id)"
}
node (Join-Path $here 'degrade.mjs')
node (Join-Path $root 'accuracy\make-index.mjs') (Join-Path $root 'accuracy\testset\synthetic')
