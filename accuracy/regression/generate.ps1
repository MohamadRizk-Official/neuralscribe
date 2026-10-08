# Regression recordings for "never invent words": speech pieces from Windows text-to-speech, then
# build.mjs combines them with silence, noise, tapping and humming.
# Output: accuracy/testset/regression/<id>.wav + .ref.txt + .meta.json  (git-ignored)
#
#   powershell -ExecutionPolicy Bypass -File accuracy/regression/generate.ps1
Add-Type -AssemblyName System.Speech
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
$tmp = Join-Path $root 'accuracy\testset\regression\_speech'
New-Item -ItemType Directory -Force $tmp | Out-Null

$pieces = [ordered]@{
  normal  = 'This is a normal recording of continuous English speech. I am describing my plans for the week, including a meeting on Monday and a dentist appointment on Wednesday afternoon.'
  nonono  = 'No, no, no, that is not what I meant at all.'
  very    = 'This part is very, very important, so please read it twice.'
  think   = 'Hmm, let me think about that for a second.'
  callback = 'I will call you back later tonight.'
}
foreach ($k in $pieces.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice('Microsoft David Desktop')
  $s.SetOutputToWaveFile((Join-Path $tmp "$k.wav"))
  $s.Speak($pieces[$k])
  $s.Dispose()
  [IO.File]::WriteAllText((Join-Path $tmp "$k.txt"), $pieces[$k], (New-Object Text.UTF8Encoding $false))
  Write-Output "spoke $k"
}
node (Join-Path $here 'build.mjs')
node (Join-Path $root 'accuracy\make-index.mjs') (Join-Path $root 'accuracy\testset\regression')
